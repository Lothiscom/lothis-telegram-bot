import express from "express";
import fetch from "node-fetch";

// =================== ENV ===================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_FREE_PROMPT_ID = process.env.OPENAI_FREE_PROMPT_ID;
const OPENAI_PREMIUM_PROMPT_ID = process.env.OPENAI_PREMIUM_PROMPT_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

const WELCOME_IMAGE_URL =
  process.env.WELCOME_IMAGE_URL ||
  "https://lothis.com/wp-content/uploads/2026/02/cropped-Lothis-app-icon-transparent.png";

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";
const METRICS_TOKEN = process.env.METRICS_TOKEN || "";
const PREMIUM_URL = process.env.PREMIUM_URL || "https://lothis.com/premium";

/**
 * Optional: hardcoded premium chat ids via env
 * Example:
 * PREMIUM_CHAT_IDS=123456789,987654321
 */
const PRELOADED_PREMIUM_CHAT_IDS = new Set(
  String(process.env.PREMIUM_CHAT_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

/**
 * Test / activation codes via env
 * Example:
 * ACTIVATION_CODES=LTHS-7Q2M-9KXA,LTHS-4P8D-WR31,LTHS-Z6NV-2TLM
 */
const ACTIVATION_CODES = new Set(
  String(process.env.ACTIVATION_CODES || "")
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean)
);

if (
  !TELEGRAM_TOKEN ||
  !OPENAI_API_KEY ||
  !OPENAI_FREE_PROMPT_ID ||
  !OPENAI_PREMIUM_PROMPT_ID ||
  !WEBHOOK_SECRET
) {
  console.error(
    "Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_FREE_PROMPT_ID, OPENAI_PREMIUM_PROMPT_ID, WEBHOOK_SECRET"
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// =================== STATE ===================
const stateByChat = new Map();
// chatId -> { prevId, lang, awaitingCode }
function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat.has(key)) {
    stateByChat.set(key, {
      prevId: null,
      lang: "nl",
      awaitingCode: false,
    });
  }
  return stateByChat.get(key);
}

function resetState(chatId) {
  stateByChat.set(String(chatId), {
    prevId: null,
    lang: "nl",
    awaitingCode: false,
  });
}

// =================== PREMIUM ===================
const activatedPremiumChatIds = new Set([...PRELOADED_PREMIUM_CHAT_IDS]);

function isPremium(chatId) {
  return activatedPremiumChatIds.has(String(chatId));
}

function activatePremium(chatId) {
  activatedPremiumChatIds.add(String(chatId));
}

function getPromptIdForUser(chatId) {
  return isPremium(chatId)
    ? OPENAI_PREMIUM_PROMPT_ID
    : OPENAI_FREE_PROMPT_ID;
}

function premiumStatusText(chatId, lang = "nl") {
  const premium = isPremium(chatId);

  if (lang === "en") {
    return premium
      ? "Status: Premium ✓"
      : `Status: Free\nUpgrade: ${PREMIUM_URL}\nOr use /code if you have an activation code.`;
  }

  if (lang === "de") {
    return premium
      ? "Status: Premium ✓"
      : `Status: Free\nUpgrade: ${PREMIUM_URL}\nOder nutze /code, wenn du einen Aktivierungscode hast.`;
  }

  return premium
    ? "Status: Premium ✓"
    : `Status: Free\nUpgrade: ${PREMIUM_URL}\nOf gebruik /code als je een activatiecode hebt.`;
}

function normalizeCode(input) {
  return String(input || "").trim().toUpperCase();
}

function consumeActivationCode(rawCode) {
  const code = normalizeCode(rawCode);

  if (!code) return { ok: false, reason: "empty" };
  if (!ACTIVATION_CODES.has(code)) return { ok: false, reason: "invalid" };

  ACTIVATION_CODES.delete(code);
  return { ok: true, code };
}

// =================== METRICS ===================
const metrics = {
  startedAt: Date.now(),
  totalUpdates: 0,
  totalMessages: 0,
  uniqueUsers: new Set(),
  lastSeenByUser: new Map(),
  starts: 0,
  codeActivations: 0,
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

// =================== TELEGRAM ===================
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
  return tgApi("sendChatAction", {
    chat_id: chatId,
    action,
  });
}

async function tgAnswerCallbackQuery(callbackQueryId) {
  return tgApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
  });
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

// =================== OPENAI ===================
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
};

function extractOutputText(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

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

function promptStyleLockInstruction() {
  return [
    "The Prompt defines your identity and response style.",
    "Stay with emotional presence, reflection, and meaning-making.",
    "Do NOT switch to generic advice or checklist-style answers unless the Prompt explicitly asks for it.",
    "If a situation sounds severe, reflect the emotional impact before moving to suggestions."
  ].join("\n");
}

async function openaiRespond({ chatId, userText }) {
  const st = getState(chatId);

  const instructions = [
    `Respond in language: ${st.lang}`,
    "Be calm, present, and thoughtful.",
    "Respond with enough depth to feel supportive.",
    "Ask one warm question that moves the conversation forward.",
    promptStyleLockInstruction(),
    telegramFormattingInstruction(),
  ].join("\n\n");

  const body = {
    model: OPENAI_MODEL,
    prompt: { id: getPromptIdForUser(chatId) },
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

// =================== MENU ===================
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

async function showInternalMenu(chatId) {
  const st = getState(chatId);

  const inlineKeyboard = [
    [
      { text: "🇳🇱 NL", callback_data: "set_lang:nl" },
      { text: "🇬🇧 EN", callback_data: "set_lang:en" },
      { text: "🇩🇪 DE", callback_data: "set_lang:de" },
    ],
    [
      { text: "🎟️ Code invoeren", callback_data: "enter_code" },
      { text: "💎 Premium", url: PREMIUM_URL },
    ],
    [
      { text: "↩️ Reset", callback_data: "reset" },
      { text: "📌 Status", callback_data: "check_status" },
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

  if (data === "check_status") {
    await tgSendMessage(chatId, premiumStatusText(chatId, st.lang));
    return;
  }

  if (data === "enter_code") {
    st.awaitingCode = true;
    await tgSendMessage(chatId, "Stuur je activatiecode hier als normaal bericht.");
    return;
  }

  if (data.startsWith("set_lang:")) {
    st.lang = data.split(":")[1];
    st.prevId = null;
    await tgSendMessage(chatId, setLangConfirm(st.lang));
    return;
  }
}

// =================== ADMIN ===================
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
      `Premium ids loaded: ${activatedPremiumChatIds.size}`,
      `Unused activation codes: ${ACTIVATION_CODES.size}`,
      `Code activations: ${metrics.codeActivations}`,
    ].join("\n")
  );
}

// =================== COMMAND HELPERS ===================
async function handleStart(chatId) {
  const premium = isPremium(chatId);

  const text = premium
    ? "Welkom terug.\nJe gebruikt nu Lothis Premium.\n\nTyp gewoon wat er speelt.\n(/menu voor instellingen)"
    : "Ik ben er. Typ gewoon wat er speelt.\n\nJe start nu in de gratis versie.\n(/menu voor instellingen)";

  await tgSendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: premium
        ? [[{ text: "📌 Bekijk status", callback_data: "check_status" }]]
        : [
            [
              { text: "🎟️ Code invoeren", callback_data: "enter_code" },
              { text: "💎 Bekijk Premium", url: PREMIUM_URL }
            ]
          ],
    },
  });
}

async function handlePremium(chatId) {
  const st = getState(chatId);
  await tgSendMessage(chatId, premiumStatusText(chatId, st.lang));
}

async function handleWhoAmI(chatId) {
  await tgSendMessage(
    chatId,
    `Jouw Telegram chat_id is:\n${chatId}\n\nGebruik dit later om premium te koppelen.`
  );
}

async function handleCodeCommand(chatId) {
  const st = getState(chatId);
  st.awaitingCode = true;
  await tgSendMessage(chatId, "Stuur je activatiecode hier als normaal bericht.");
}

async function handleSubmittedCode(chatId, submittedText) {
  const st = getState(chatId);
  st.awaitingCode = false;

  if (isPremium(chatId)) {
    await tgSendMessage(chatId, "Je account staat al op Premium ✓");
    return true;
  }

  const result = consumeActivationCode(submittedText);

  if (!result.ok) {
    await tgSendMessage(chatId, "Deze code klopt niet of is al gebruikt.");
    return true;
  }

  activatePremium(chatId);
  metrics.codeActivations += 1;

  await tgSendMessage(
    chatId,
    "Gelukt ✨\nJe Premium is geactiveerd.\n\nTyp gewoon verder of gebruik /premium om je status te checken."
  );

  return true;
}

// =================== WEBHOOK ===================
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.callback_query) {
      await handleCallback(update);
      return;
    }

    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text = msg.text?.trim();

    if (!chatId) return;

    trackUpdate(chatId, Boolean(text), text);

    const st = getState(chatId);

    if (text === "/stats") {
      await handleStats(chatId);
      return;
    }

    if (text === "/start") {
      await handleStart(chatId);
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

    if (text === "/premium") {
      await handlePremium(chatId);
      return;
    }

    if (text === "/whoami") {
      await handleWhoAmI(chatId);
      return;
    }

    if (text === "/code") {
      await handleCodeCommand(chatId);
      return;
    }

    if (!text) {
      await tgSendMessage(chatId, "Stuur het even als tekst, dan pak ik ’m meteen.");
      return;
    }

    if (st.awaitingCode) {
      await handleSubmittedCode(chatId, text);
      return;
    }

    tgSendChatAction(chatId, "typing").catch(() => {});

    const reply = await openaiRespond({ chatId, userText: text });
    await tgSendMessage(chatId, reply || "…");
  } catch (e) {
    console.error("Webhook error:", e);

    const chatId =
      req.body?.message?.chat?.id ||
      req.body?.edited_message?.chat?.id ||
      req.body?.callback_query?.message?.chat?.id;

    if (chatId) {
      await tgSendMessage(
        chatId,
        "Er ging iets mis. Probeer het over een paar seconden nog eens."
      ).catch(() => {});
    }
  }
});

// =================== HEALTH ===================
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
    premiumIdsLoaded: activatedPremiumChatIds.size,
    unusedActivationCodes: ACTIVATION_CODES.size,
    codeActivations: metrics.codeActivations,
  });
});

app.get("/", (_req, res) => res.send("Lothis Telegram Bot is running ✨"));

// =================== START ===================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis Telegram Bot running on :${PORT}`);
});
