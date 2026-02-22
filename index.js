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
const stateByChat = new Map(); // chatId -> { prevId, lang, mode }

function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat.has(key)) {
    // default taal = nl (pas aan als je en default wil)
    stateByChat.set(key, { prevId: null, lang: "nl", mode: "reflect" });
  }
  return stateByChat.get(key);
}

function resetState(chatId) {
  stateByChat.set(String(chatId), { prevId: null, lang: "nl", mode: "reflect" });
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
    `Respond in language: ${st.lang}`,
    promptStyleLockInstruction(),
    modeInstruction(st.mode),
    telegramFormattingInstruction(),
  ].join("\n\n");

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

// =================== UI (internal menu buttons) ===================
function menuCaption(lang) {
  if (lang === "de") return "Schnell starten: schreib einfach.\n\nEinstellungen:";
  if (lang === "en") return "Start instantly: just type.\n\nSettings:";
  return "Start direct: typ gewoon.\n\nInstellingen:";
}

function setLangConfirm(lang) {
  if (lang === "de") return "Taal: Deutsch ✓";
  if (lang === "en") return "Language: English ✓";
  return "Taal: Nederlands ✓";
}

function setModeConfirm(mode, lang) {
  const l = lang || "nl";
  const label =
    mode === "clarity" ? (l === "nl" ? "Clarity" : "Clarity") :
    mode === "breathe" ? (l === "nl" ? "Breathe" : "Breathe") :
    (l === "nl" ? "Reflect" : "Reflect");
  return (l === "de")
    ? `Modus: ${label} ✓`
    : (l === "en")
    ? `Mode: ${label} ✓`
    : `Modus: ${label} ✓`;
}

async function showInternalMenu(chatId) {
  const st = getState(chatId);
  const inlineKeyboard = [
    [
      { text: "🪷 Reflect", callback_data: "set_mode:reflect" },
      { text: "🔎 Clarity", callback_data: "set_mode:clarity" },
      { text: "🌬️ Breathe", callback_data: "set_mode:breathe" },
    ],
    [
      { text: "🇳🇱 NL", callback_data: "set_lang:nl" },
      { text: "🇬🇧 EN", callback_data: "set_lang:en" },
      { text: "🇩🇪 DE", callback_data: "set_lang:de" },
    ],
    [
      { text: "↩️ Reset", callback_data: "reset" },
      { text: "✨ lothis.com", url: "https://lothis.com" },
    ],
  ];

  await tgSendPhotoWithButtons(chatId, menuCaption(st.lang), inlineKeyboard);
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

  if (data === "reset") {
    resetState(chatId);
    await tgSendMessage(chatId, "Reset klaar. Typ gewoon verder of /menu.");
    return;
  }

  if (data.startsWith("set_lang:")) {
    st.lang = data.split(":")[1];
    st.prevId = null; // “frisse” context na taalwissel
    await tgSendMessage(chatId, setLangConfirm(st.lang));
    return;
  }

  if (data.startsWith("set_mode:")) {
    st.mode = data.split(":")[1];
    await tgSendMessage(chatId, setModeConfirm(st.mode, st.lang));
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
      `Starts: ${metrics.starts}`,
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

    // Admin
    if (text === "/stats") {
      await handleStats(chatId);
      return;
    }

    // Commands
    if (text === "/start") {
      await tgSendMessage(chatId, "Ik ben er. Typ gewoon wat er speelt.\n(/menu voor instellingen)");
      return;
    }

    if (text === "/menu") {
      await showInternalMenu(chatId);
      return;
    }

    if (text === "/reset") {
      resetState(chatId);
      await tgSendMessage(chatId, "Reset klaar. Typ gewoon verder of /menu.");
      return;
    }

    // Non-text
    if (!text) {
      await tgSendMessage(chatId, "Stuur het even als tekst, dan pak ik ’m meteen.");
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
