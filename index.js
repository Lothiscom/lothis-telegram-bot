import express from "express";
import fetch from "node-fetch";

// =================== ENV ===================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID; // pmpt_...
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

const WELCOME_IMAGE_URL =
  process.env.WELCOME_IMAGE_URL ||
  "https://lothis.com/wp-content/uploads/2025/12/lotus-tg-animation.jpg";

// Metrics/Admin
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || ""; // jouw Telegram chat_id (string)
const METRICS_TOKEN = process.env.METRICS_TOKEN || ""; // random secret voor /metrics

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

// =================== METRICS (in-memory) ===================
const metrics = {
  startedAt: Date.now(),
  totalUpdates: 0,
  totalMessages: 0,
  uniqueUsers: new Set(),
  lastSeenByUser: new Map(),
  starts: 0,
};

function trackUpdate(chatId, hasText, textValue) {
  metrics.totalUpdates += 1;

  if (chatId) {
    const key = String(chatId);
    metrics.uniqueUsers.add(key);
    metrics.lastSeenByUser.set(key, Date.now());
  }

  if (hasText) metrics.totalMessages += 1;
  if (textValue === "/start") metrics.starts += 1;
}

function countActiveUsersSince(msAgo) {
  const cutoff = Date.now() - msAgo;
  let count = 0;
  for (const ts of metrics.lastSeenByUser.values()) {
    if (ts >= cutoff) count += 1;
  }
  return count;
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

async function tgAnswerCallbackQuery(callbackQueryId) {
  return tgApi("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

async function tgSendPhotoWithButtons(chatId, caption, inlineKeyboard) {
  if (WELCOME_IMAGE_URL) {
    const res = await tgApi("sendPhoto", {
      chat_id: chatId,
      photo: WELCOME_IMAGE_URL,
      caption,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
    if (res) return res;
  }
  return tgSendMessage(chatId, caption, {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
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

// =================== UI COPY ===================
function menuCaption(lang) {
  if (lang === "de") return "Schnellmenü — starte einfach zu schreiben.\n\nEinstellungen:";
  if (lang === "en") return "Quick menu — you can start talking right away.\n\nSettings:";
  return "Snelmenu — je kunt meteen beginnen met praten.\n\nInstellingen:";
}

function firstPromptAfterLang(lang) {
  if (lang === "de") return "Alles klar. Du kannst jetzt einfach schreiben.\nTippe /menu für Einstellungen.";
  if (lang === "en") return "Nice. You can start talking now.\nType /menu for settings.";
  return "Top. Je kunt nu meteen praten.\nTyp /menu voor instellingen.";
}

async function askLanguageFlow(chatId) {
  const lines = [
    "Lothis is here.",
    "",
    "Choose your voice:",
    "NL  (Nederlands)",
    "EN  (English)",
    "DE  (Deutsch)"
  ].join("\n");

  await tgSendPhotoWithCaption(chatId, lines);
}

async function showQuickMenu(chatId) {
  const st = getState(chatId);
  const lang = st.lang || "nl";

  const inlineKeyboard = [
    [
      { text: "🪷 Reflect", callback_data: "set_mode:reflect" },
      { text: "🔎 Clarity", callback_data: "set_mode:clarity" },
      { text: "🌬️ Breathe", callback_data: "set_mode:breathe" }
    ],
    [
      { text: "🌍 Language", callback_data: "choose_lang" },
      { text: "↩️ Reset", callback_data: "reset" }
    ],
    [{ text: "✨ lothis.com", url: "https://lothis.com" }]
  ];

  await tgSendPhotoWithButtons(chatId, menuCaption(lang), inlineKeyboard);
}

async function showLanguagePickerInline(chatId) {
  const inlineKeyboard = [
    [{ text: "🇳🇱 Nederlands", callback_data: "set_lang:nl" }],
    [{ text: "🇬🇧 English", callback_data: "set_lang:en" }],
    [{ text: "🇩🇪 Deutsch", callback_data: "set_lang:de" }],
  ];

  await tgSendMessage(chatId, "Choose language / Kies taal / Sprache wählen:", {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

// =================== CALLBACKS ===================
async function handleCallback(update) {
  const cb = update.callback_query;
  if (!cb) return;

  const chatId = cb.message?.chat?.id;
  const data = cb.data;
  if (!chatId || !data) return;

  await tgAnswerCallbackQuery(cb.id).catch(() => {});
  const st = getState(chatId);

  if (data === "choose_lang") {
    await showLanguagePickerInline(chatId);
    return;
  }

  if (data === "reset") {
    resetState(chatId);
    await tgSendMessage(chatId, "Reset klaar. Typ /start.");
    return;
  }

  if (data.startsWith("set_lang:")) {
    st.lang = data.split(":")[1];
    st.stage = "ready";
    st.prevId = null;
    await tgSendMessage(chatId, firstPromptAfterLang(st.lang));
    return;
  }

  if (data.startsWith("set_mode:")) {
    st.mode = data.split(":")[1];
    // geen lange uitleg; gewoon bevestiging subtiel
    await tgSendMessage(chatId, "✓");
    return;
  }
}

// =================== ADMIN: /stats ===================
async function handleStats(chatId) {
  if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) {
    await tgSendMessage(chatId, "Nope 🙂");
    return;
  }

  const uptimeMin = Math.floor((Date.now() - metrics.startedAt) / 60000);
  const dau = countActiveUsersSince(24 * 60 * 60 * 1000);
  const wau = countActiveUsersSince(7 * 24 * 60 * 60 * 1000);

  await tgSendMessage(
    chatId,
    [
      "Lothis bot stats",
      `Uptime: ${uptimeMin} min`,
      `Unique users (since restart): ${metrics.uniqueUsers.size}`,
      `Active users (24h): ${dau}`,
      `Active users (7d): ${wau}`,
      `Total updates: ${metrics.totalUpdates}`,
      `Total messages: ${metrics.totalMessages}`,
      `Starts: ${metrics.starts}`
    ].join("\n")
  );
}

// =================== WEBHOOK ===================
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    // callbacks (menu buttons)
    if (update.callback_query) {
      await handleCallback(update);
      return;
    }

    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text = msg.text?.trim();
    if (!chatId) return;

    // track
    trackUpdate(chatId, Boolean(text), text);

    const st = getState(chatId);

    // Admin
    if (text === "/stats") {
      await handleStats(chatId);
      return;
    }

    // Commands
    if (text === "/reset") {
      resetState(chatId);
      await tgSendMessage(chatId, "Reset klaar. Typ /start.");
      return;
    }

    if (text === "/start") {
      if (!st.lang) {
        st.stage = "needs_lang";
        await askLanguageFlow(chatId);
      } else {
        st.stage = "ready";
        await tgSendMessage(chatId, "Je kunt meteen beginnen met praten.\nTyp /menu voor instellingen.");
      }
      return;
    }

    if (text === "/menu") {
      if (!st.lang) {
        st.stage = "needs_lang";
        await askLanguageFlow(chatId);
      } else {
        await showQuickMenu(chatId);
      }
      return;
    }

    if (text === "/language") {
      if (!st.lang) {
        st.stage = "needs_lang";
        await askLanguageFlow(chatId);
      } else {
        await showLanguagePickerInline(chatId);
      }
      return;
    }

    // Non-text
    if (!text) {
      await tgSendMessage(chatId, "Stuur het even als tekst, dan pak ik ’m meteen.");
      return;
    }

    // Language gate (tekst kiezen: NL/EN/DE)
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
      st.prevId = null;

      await tgSendMessage(chatId, firstPromptAfterLang(lang));
      // Optioneel: direct menu tonen? (kan, maar jij wilde snel praten)
      // await showQuickMenu(chatId);
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

// =================== HEALTH + METRICS ===================
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/metrics", (req, res) => {
  const token = req.headers["x-metrics-token"] || req.query.token || "";
  if (!METRICS_TOKEN || String(token) !== String(METRICS_TOKEN)) {
    return res.status(401).json({ ok: false });
  }

  const uptimeSec = Math.floor((Date.now() - metrics.startedAt) / 1000);

  res.json({
    ok: true,
    uptimeSec,
    uniqueUsers: metrics.uniqueUsers.size,
    active24h: countActiveUsersSince(24 * 60 * 60 * 1000),
    active7d: countActiveUsersSince(7 * 24 * 60 * 60 * 1000),
    totalUpdates: metrics.totalUpdates,
    totalMessages: metrics.totalMessages,
    starts: metrics.starts,
  });
});

app.get("/", (_req, res) => res.send("Lothis Telegram Bot is running ✨"));

// =================== START ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis Telegram Bot running on :${PORT}`);
});
