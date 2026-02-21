import express from "express";
import fetch from "node-fetch";

// ---------- ENV ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID; // pmpt_...
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

const WELCOME_ANIMATION_URL = process.env.WELCOME_ANIMATION_URL || "";
const WELCOME_IMAGE_URL =
  process.env.WELCOME_IMAGE_URL ||
  "https://lothis.com/wp-content/uploads/2025/12/lotus-tg-animation.jpg"; // ✅ https

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_PROMPT_ID || !PUBLIC_BASE_URL || !WEBHOOK_SECRET) {
  console.error(
    "Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_PROMPT_ID, PUBLIC_BASE_URL, WEBHOOK_SECRET"
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- In-memory state (beta) ----------
const stateByChat = new Map(); // chatId -> { prevId, language }

function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat.has(key)) stateByChat.set(key, { prevId: null, language: null });
  return stateByChat.get(key);
}
function setLanguage(chatId, lang) { getState(chatId).language = lang; }
function getLanguage(chatId) { return getState(chatId).language; }
function setPrevId(chatId, prevId) { getState(chatId).prevId = prevId; }
function getPrevId(chatId) { return getState(chatId).prevId; }

// ---------- Telegram helpers ----------
async function tgSendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text || ""),
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendMessage failed:", res.status, t);
  }
}

async function tgSendPhotoWithButtons(chatId, caption, inlineKeyboard) {
  if (!WELCOME_IMAGE_URL) {
    return tgSendMessage(chatId, caption);
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: WELCOME_IMAGE_URL,
      caption,
      reply_markup: { inline_keyboard: inlineKeyboard }
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendPhoto failed:", res.status, t);
  }
}

// ---------- OpenAI Responses (Prompt) ----------
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json"
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

async function openaiRespond({ chatId, userText, lang }) {
  const prev = getPrevId(chatId);

  const instructions = [
    lang ? `Respond in language: ${lang}` : null,
    telegramFormattingInstruction()
  ].filter(Boolean).join("\n\n");

  const body = {
    model: OPENAI_MODEL,
    prompt: { id: OPENAI_PROMPT_ID },
    input: [{ role: "user", content: userText }],
    previous_response_id: prev || undefined,
    instructions
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI responses failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  const text = extractOutputText(json);

  setPrevId(chatId, json.id);
  return text;
}

async function lothisReply(chatId, userText) {
  const lang = getLanguage(chatId);
  try {
    const text = await openaiRespond({ chatId, userText, lang });
    return text || "Ik hoor je. Wil je dat nog één keer zeggen?";
  } catch (e) {
    console.error("OpenAI error:", e);
    return "Ik ben er heel even niet lekker doorheen. Probeer het zo nog een keer.";
  }
}

// ---------- UI helpers ----------
async function sendLanguageKeyboard(chatId) {
  const lang = getLanguage(chatId);
  const text =
    lang === "nl"
      ? "Kies even de taal waarin je wilt praten:"
      : lang === "de"
      ? "Wähle bitte die Sprache, in der du sprechen möchtest:"
      : "Choose the language you want to talk in:";

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        keyboard: [
          [{ text: "🇳🇱 Nederlands" }],
          [{ text: "🇬🇧 English" }],
          [{ text: "🇩🇪 Deutsch" }]
        ],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendMessage (language keyboard) failed:", res.status, t);
  }
}

async function languageCyclingIntro(chatId) {
  const urlSend = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const urlEdit = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`;
  const lines = [
    "Welcome at Lothis _",
    "Bienvenido a Lothis _",
    "مرحبًا بك في لوثيس _",
    "欢迎来到 Lothis _",
    "Welkom bij Lothis _"
  ];

  const firstRes = await fetch(urlSend, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines[0] })
  });

  if (!firstRes.ok) {
    await sendLanguageKeyboard(chatId);
    return;
  }

  const data = await firstRes.json().catch(() => null);
  const messageId = data?.result?.message_id;
  if (!messageId) {
    await sendLanguageKeyboard(chatId);
    return;
  }

  for (let i = 1; i < lines.length; i++) {
    await new Promise((r) => setTimeout(r, 800));
    await fetch(urlEdit, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: lines[i] })
    }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 900));
  await fetch(urlEdit, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: "👉 Choose your language / Kies je taal:"
    })
  }).catch(() => {});

  await sendLanguageKeyboard(chatId);
}

async function sendWelcomeCard(chatId) {
  const lang = getLanguage(chatId);

  const caption =
    lang === "nl"
      ? "Welkom bij Lothis 👋\n\nJe rustige plek om even te praten zonder oordeel.\n\nKies wat nu het beste bij je past:"
      : lang === "de"
      ? "Willkommen bei Lothis 👋\n\nEin ruhiger Raum, um zu reden und durchzuatmen.\n\nWähle, was du gerade brauchst:"
      : "Welcome to Lothis 👋\n\nYour calm space to talk, reflect, and feel supported.\n\nChoose what fits you best right now:";

  const startLabel =
    lang === "nl" ? "💬 Praat met Lothis" : lang === "de" ? "💬 Mit Lothis chatten" : "💬 Start chat";

  const langLabel =
    lang === "nl" ? "🌍 Taal kiezen" : lang === "de" ? "🌍 Sprache wählen" : "🌍 Choose language";

  const inlineKeyboard = [
    [{ text: startLabel, callback_data: "start_chat" }],
    [{ text: langLabel, callback_data: "choose_lang" }],
    [{ text: "✨ What is Lothis?", url: "https://lothis.com" }]
  ];

  await tgSendPhotoWithButtons(chatId, caption, inlineKeyboard);
}

// ---------- Callback handler ----------
async function handleCallback(update) {
  const callback = update.callback_query;
  if (!callback) return;

  const chatId = callback.message?.chat?.id;
  const data = callback.data;
  if (!chatId || !data) return;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callback.id })
  }).catch(() => {});

  const lang = getLanguage(chatId);

  if (data === "choose_lang") {
    await sendLanguageKeyboard(chatId);
    return;
  }

  if (data === "start_chat") {
    if (!lang) {
      await tgSendMessage(chatId, "Kies eerst even een taal, dan kunnen we echt goed praten. 🙂");
      await sendLanguageKeyboard(chatId);
      return;
    }

    const msg =
      lang === "nl"
        ? "Oké, ik ben er. Waar zit je hoofd nu het meeste mee?"
        : lang === "de"
        ? "Alles klar, ich bin da. Woran denkst du gerade am meisten?"
        : "I’m here. What’s on your mind right now?";

    await tgSendMessage(chatId, msg);
  }
}

// ---------- Webhook endpoint ----------
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.callback_query) {
      await handleCallback(update);
      return;
    }

    const message = update.message || update.edited_message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = message.text?.trim();
    if (!chatId) return;

    // /start
    if (text === "/start") {
      const existingLang = getLanguage(chatId);
      if (existingLang) await sendWelcomeCard(chatId);
      else await languageCyclingIntro(chatId);
      return;
    }

    // language selection
    const languages = {
      "🇳🇱 Nederlands": "nl",
      "🇬🇧 English": "en",
      "🇩🇪 Deutsch": "de"
    };

    if (text && languages[text]) {
      const langCode = languages[text];
      setLanguage(chatId, langCode);

      // ✅ Direct welcome card met afbeelding + knoppen
      await sendWelcomeCard(chatId);
      return;
    }

    if (!text) {
      await tgSendMessage(chatId, "Stuur me even in tekst wat je bedoelt, dan pak ik ’m meteen.");
      return;
    }

    const reply = await lothisReply(chatId, text);
    await tgSendMessage(chatId, reply);

  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ---------- Health & root ----------
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.send("Lothis Telegram Bot is running ✨"));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis Telegram Bot running on :${PORT}`);
});
