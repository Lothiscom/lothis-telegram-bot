import express from "express";
import fetch from "node-fetch";

// =================== ENV ===================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID; // pmpt_...
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // optional
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

const WELCOME_IMAGE_URL =
  process.env.WELCOME_IMAGE_URL ||
  "https://lothis.com/wp-content/uploads/2025/12/lotus-tg-animation.jpg";

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_PROMPT_ID || !WEBHOOK_SECRET) {
  console.error(
    "Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_PROMPT_ID, WEBHOOK_SECRET"
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// =================== STATE (in-memory beta) ===================
// stage: needs_lang | ready
const stateByChat = new Map(); // chatId -> { prevId, lang, mode, stage }

function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat.has(key)) {
    stateByChat.set(key, { prevId: null, lang: null, mode: "reflect", stage: "needs_lang" });
  }
  return stateByChat.get(key);
}

function resetState(chatId) {
  stateByChat.set(String(chatId), { prevId: null, lang: null, mode: "reflect", stage: "needs_lang" });
}

// =================== TELEGRAM API HELPERS ===================
async function tgApi(method, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(`Telegram ${method} failed:`, res.status, t);
    return null;
  }
  return res.json().catch(() => null);
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tgApi("sendMessage", {
    chat_id: chatId,
    text: String(text || ""),
    disable_web_page_preview: true,
    ...extra,
  });
}

async function tgSendChatAction(chatId, action = "typing") {
  return tgApi("sendChatAction", { chat_id: chatId, action });
}

async function tgSendPhotoWithCaption(chatId, caption) {
  if (!WELCOME_IMAGE_URL) return tgSendMessage(chatId, caption);

  const res = await tgApi("sendPhoto", {
    chat_id: chatId,
    photo: WELCOME_IMAGE_URL,
    caption,
  });

  return res ? res : tgSendMessage(chatId, caption);
}

// =================== OPENAI (Responses + Prompt) ===================
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
};

function extractOutputText(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
  let out = "";
  const output = json?.output || [];
  for (const item of output) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && c?.text) out += c.text;
      if (c?.type === "text" && typeof c?.text === "string") out += c.text;
      if (c?.type === "text" && c?.text?.value) out += c.text.value;
    }
  }
  return out.trim();
}

function telegramFormattingInstruction() {
  return [
    "Format for Telegram: plain text only.",
    "Use short paragraphs and blank lines.",
    "No markdown, no **bold**, no special bullet symbols.",
    "If you need a list: use simple numbering like '1) ...' on separate lines."
  ].join("\n");
}

function modeInstruction(mode) {
  if (mode === "clarity") {
    return [
      "Mode: CLARITY.",
      "Be concise and practical.",
      "Ask at most one clarifying question.",
      "Prefer 3–5 short steps."
    ].join("\n");
  }
  if (mode === "breathe") {
    return [
      "Mode: BREATHE.",
      "Keep it very gentle and simple.",
      "Use short, soothing sentences."
    ].join("\n");
  }
  return [
    "Mode: REFLECT.",
    "Be calm, present, and thoughtful.",
    "Respond with enough depth to feel supportive.",
    "Ask one warm question that moves the conversation forward."
  ].join("\n");
}

// ⭐ Dit is de belangrijkste wijziging: “Telegram moet je Prompt-stijl blijven volgen”
function promptStyleLockInstruction() {
  return [
    "The Prompt defines your identity and response style.",
    "Stay with emotional presence, reflection, and meaning-making.",
    "Do NOT switch to generic advice, safety checklists, or external help suggestions unless the Prompt explicitly asks for it.",
    "If a situation sounds severe, reflect the emotional impact and ask a grounding question instead of offering solutions."
  ].join("\n");
}

async function openaiRespond({ chatId, userText }) {
  const st = getState(chatId);

  const instructions = [
    st.lang ? `Respond in language: ${st.lang}` : null,
    promptStyleLockInstruction(),
    modeInstruction(st.mode),
    telegramFormattingInstruction(),
  ].filter(Boolean).join("\n\n");

  const body = {
    model: OPENAI_MODEL,
    prompt: { id: OPENAI_PROMPT_ID },
    input: [{ role: "user", content: userText }],
    previous_response_id: st.prevId || undefined,
    instructions,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI responses failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  st.prevId = json.id;
  return extractOutputText(json);
}

// =================== LANGUAGE PARSING ===================
function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

function parseLanguage(text) {
  const x = normalize(text);

  if (x === "nl" || x === "nederlands" || x === "dutch" || x.includes("neder")) return "nl";
  if (x === "en" || x === "english" || x === "engels" || x.includes("engl")) return "en";
  if (x === "de" || x === "deutsch" || x === "duits" || x.includes("deut")) return "de";

  if (x.includes("🇳🇱")) return "nl";
  if (x.includes("🇬🇧") || x.includes("🇺🇸")) return "en";
  if (x.includes("🇩🇪")) return "de";

  return null;
}

// =================== COPY / FLOWS ===================
function menuText(lang) {
  if (lang === "de") {
    return [
      "Menu",
      "",
      "1) Reflect  — ruhig & vertiefend",
      "2) Clarity  — kurz & konkret",
      "3) Breathe  — einfach & sanft",
      "",
      "Tippe: 1, 2 oder 3",
      "",
      "Commands:",
      "/language  (Sprache ändern)",
      "/menu      (Menü zeigen)",
      "/reset     (alles zurücksetzen)"
    ].join("\n");
  }
  if (lang === "en") {
    return [
      "Menu",
      "",
      "1) Reflect  — calm & deep",
      "2) Clarity  — short & practical",
      "3) Breathe  — simple & gentle",
      "",
      "Type: 1, 2 or 3",
      "",
      "Commands:",
      "/language  (change language)",
      "/menu      (show menu)",
      "/reset     (reset everything)"
    ].join("\n");
  }
  return [
    "Menu",
    "",
    "1) Reflect  — rustig & verdiepend",
    "2) Clarity  — kort & concreet",
    "3) Breathe  — simpel & zacht",
    "",
    "Typ: 1, 2 of 3",
    "",
    "Commands:",
    "/language  (taal wijzigen)",
    "/menu      (menu tonen)",
    "/reset     (alles resetten)"
  ].join("\n");
}

async function askLanguageFlow(chatId) {
  const lines = [
    "Lothis is here.",
    "",
    "Choose your voice.",
    "",
    "Type one of these:",
    "NL  (Nederlands)",
    "EN  (English)",
    "DE  (Deutsch)"
  ].join("\n");

  await tgSendPhotoWithCaption(chatId, lines);
}

async function setModeFromChoice(chatId, choice) {
  const st = getState(chatId);
  if (choice === "1") st.mode = "reflect";
  if (choice === "2") st.mode = "clarity";
  if (choice === "3") st.mode = "breathe";

  const lang = st.lang || "nl";
  if (lang === "de") {
    if (st.mode === "clarity") return "Clarity ist aktiv. Sag mir in einem Satz, was los ist.";
    if (st.mode === "breathe") return "Breathe ist aktiv. Wo spürst du es gerade am stärksten?";
    return "Reflect ist aktiv. Woran denkst du gerade am meisten?";
  }
  if (lang === "en") {
    if (st.mode === "clarity") return "Clarity is on. Tell me what’s going on in one sentence.";
    if (st.mode === "breathe") return "Breathe is on. Where do you feel it most in your body right now?";
    return "Reflect is on. What’s on your mind right now?";
  }
  if (st.mode === "clarity") return "Clarity staat aan. Kun je in één zin zeggen wat er speelt?";
  if (st.mode === "breathe") return "Breathe staat aan. Waar voel je het nu het meest in je lichaam?";
  return "Reflect staat aan. Waar zit je hoofd nu het meeste mee?";
}

// =================== WEBHOOK ===================
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text = msg.text?.trim();
    if (!chatId) return;

    const st = getState(chatId);

    // Commands
    if (text === "/reset") {
      resetState(chatId);
      await tgSendMessage(chatId, "Reset klaar. Typ /start.");
      return;
    }

    if (text === "/start") {
      // start altijd met taal als die er nog niet is
      if (!st.lang) {
        st.stage = "needs_lang";
        await askLanguageFlow(chatId);
      } else {
        st.stage = "ready";
        await tgSendMessage(chatId, menuText(st.lang));
      }
      return;
    }

    if (text === "/language") {
      st.stage = "needs_lang";
      await askLanguageFlow(chatId);
      return;
    }

    if (text === "/menu") {
      if (!st.lang) {
        st.stage = "needs_lang";
        await askLanguageFlow(chatId);
      } else {
        await tgSendMessage(chatId, menuText(st.lang));
      }
      return;
    }

    // Non-text
    if (!text) {
      await tgSendMessage(chatId, "Stuur het even als tekst, dan pak ik ’m meteen.");
      return;
    }

    // Language gate
    if (!st.lang || st.stage === "needs_lang") {
      const lang = parseLanguage(text);
      if (!lang) {
        await tgSendMessage(
          chatId,
          "Kies eerst even een taal: typ NL, EN of DE.\n(Je mag ook ‘Nederlands/English/Deutsch’ typen.)"
        );
        return;
      }

      st.lang = lang;
      st.stage = "ready";
      st.prevId = null; // nieuw “gesprek”-gevoel

      if (lang === "en") await tgSendMessage(chatId, "Nice. We’ll talk in English.");
      if (lang === "de") await tgSendMessage(chatId, "Alles klar. Wir sprechen Deutsch.");
      if (lang === "nl") await tgSendMessage(chatId, "Top. We praten Nederlands.");

      await tgSendMessage(chatId, menuText(lang));
      return;
    }

    // Menu choices (1/2/3)
    if (text === "1" || text === "2" || text === "3") {
      const msg2 = await setModeFromChoice(chatId, text);
      await tgSendMessage(chatId, msg2);
      return;
    }

    // Normal message -> OpenAI
    tgSendChatAction(chatId, "typing").catch(() => {});
    const reply = await openaiRespond({ chatId, userText: text });
    await tgSendMessage(chatId, reply || "…");
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// =================== HEALTH ===================
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.send("Lothis Telegram Bot is running ✨"));

// =================== START ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis Telegram Bot running on :${PORT}`);
  if (PUBLIC_BASE_URL) console.log("Base:", PUBLIC_BASE_URL);
});
