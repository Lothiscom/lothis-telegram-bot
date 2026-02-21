import express from "express";
import Database from "better-sqlite3";
import fetch from "node-fetch";

// ---------- ENV ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// NEW (Prompts)
const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

// Animatie gebruiken we nu niet (maar houden de var zodat je later makkelijk kunt omschakelen)
const WELCOME_ANIMATION_URL = process.env.WELCOME_ANIMATION_URL || "";

// Static welcome image (jouw lotus-afbeelding als default)
const WELCOME_IMAGE_URL =
  process.env.WELCOME_IMAGE_URL ||
  "http://lothis.com/wp-content/uploads/2025/12/lotus-tg-animation.jpg";

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_PROMPT_ID || !PUBLIC_BASE_URL) {
  console.error(
    "Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_PROMPT_ID, PUBLIC_BASE_URL"
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- DB (chat_id -> previous_response_id + language) ----------
// We maken een nieuwe tabel zodat je oude Assistants-threads niet in de weg zitten.
const db = new Database("lothis.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    chat_id              TEXT PRIMARY KEY,
    previous_response_id TEXT,
    language             TEXT,
    updated_at           INTEGER NOT NULL
  );
`);

const getConv = db.prepare(
  "SELECT previous_response_id, language FROM conversations WHERE chat_id = ?"
);

const upsertConv = db.prepare(`
  INSERT INTO conversations (chat_id, previous_response_id, language, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    previous_response_id = COALESCE(excluded.previous_response_id, conversations.previous_response_id),
    language             = COALESCE(excluded.language, conversations.language),
    updated_at           = excluded.updated_at
`);

const setLanguage = db.prepare(`
  UPDATE conversations
  SET language = ?, updated_at = ?
  WHERE chat_id = ?
`);

const getLanguage = db.prepare(`
  SELECT language FROM conversations WHERE chat_id = ?
`);

// ---------- Telegram helpers ----------
async function tgSendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendMessage failed:", res.status, t);
  }
}

// Static image welkomstcard (met inline buttons)
async function tgSendPhotoWithButtons(chatId, caption, inlineKeyboard) {
  if (!WELCOME_IMAGE_URL) {
    // fallback naar tekst-only
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: caption,
        reply_markup: { inline_keyboard: inlineKeyboard }
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("Telegram sendMessage (welcome fallback) failed:", res.status, t);
    }
    return;
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

// ---------- OpenAI Responses helpers ----------
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json"
};

function extractOutputText(json) {
  // Responses geeft vaak output_text; maar we hebben een fallback.
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

async function openaiRespond({ chatId, userText, lang }) {
  const row = getConv.get(String(chatId));
  const prev = row?.previous_response_id || null;

  const body = {
    model: OPENAI_MODEL,
    prompt: { id: OPENAI_PROMPT_ID },
    input: [{ role: "user", content: userText }],
    previous_response_id: prev || undefined,
    // taal-instructie (zodat jullie geen [LANG:xx] hacks nodig hebben)
    instructions: lang ? `Respond in language: ${lang}` : undefined
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Responses failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  const text = extractOutputText(json);

  // update conv state
  upsertConv.run(String(chatId), json.id, row?.language || null, Date.now());

  return text;
}

async function lothisReply(chatId, userText) {
  // Zorg dat er altijd een row bestaat (handig voor language/state)
  const row = getConv.get(String(chatId));
  if (!row) upsertConv.run(String(chatId), null, null, Date.now());

  const lang = getLanguage.get(String(chatId))?.language || null;

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
  const lang = getLanguage.get(String(chatId))?.language;
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

// ✨ Language-Cycling Intro (5 talen met welkomstzinnen)
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

  // Eerste message
  const firstRes = await fetch(urlSend, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines[0] })
  });

  if (!firstRes.ok) {
    const t = await firstRes.text().catch(() => "");
    console.error("languageCyclingIntro sendMessage failed:", firstRes.status, t);
    await sendLanguageKeyboard(chatId);
    return;
  }

  const data = await firstRes.json().catch(() => null);
  const messageId = data?.result?.message_id;

  if (!messageId) {
    await sendLanguageKeyboard(chatId);
    return;
  }

  // Wissel de talen 1 voor 1
  for (let i = 1; i < lines.length; i++) {
    await new Promise((r) => setTimeout(r, 800));
    await fetch(urlEdit, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: lines[i] })
    }).catch(() => {});
  }

  // Finale tekst
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
  const lang = getLanguage.get(String(chatId))?.language;

  const caption =
    lang === "nl"
      ? "Welkom bij Lothis 👋\n\nJe rustige plek om even te praten zonder oordeel.\n\nKies wat nu het beste bij je past:"
      : lang === "de"
      ? "Willkommen bei Lothis 👋\n\nEin ruhiger Raum, um zu reden und durchzuatmen.\n\nWähle, was du gerade brauchst:"
      : "Welcome to Lothis 👋\n\nYour calm space to talk, reflect, and feel supported.\n\nChoose what fits you best right now:";

  const startLabel =
    lang === "nl"
      ? "💬 Praat met Lothis"
      : lang === "de"
      ? "💬 Mit Lothis chatten"
      : "💬 Start chat";

  const langLabel =
    lang === "nl"
      ? "🌍 Taal kiezen"
      : lang === "de"
      ? "🌍 Sprache wählen"
      : "🌍 Choose language";

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

  // Stop Telegram spinner
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callback.id })
  }).catch(() => {});

  const lang = getLanguage.get(String(chatId))?.language;

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
    return;
  }
}

// ---------- Webhook endpoint ----------
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  // Telegram expects fast 200 OK
  res.sendStatus(200);

  try {
    const update = req.body;

    // 1) inline button callbacks
    if (update.callback_query) {
      await handleCallback(update);
      return;
    }

    // 2) normale berichten
    const message = update.message || update.edited_message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = message.text?.trim();
    if (!chatId) return;

    // ----- /start: Language-Cycling Intro voor nieuwe users, anders direct welcome card -----
    if (text === "/start") {
      // Zorg dat conv row bestaat
      const row = getConv.get(String(chatId));
      if (!row) upsertConv.run(String(chatId), null, null, Date.now());

      const existingLang = getLanguage.get(String(chatId))?.language || null;
      if (existingLang) {
        await sendWelcomeCard(chatId);
      } else {
        await languageCyclingIntro(chatId);
      }
      return;
    }

    // ----- taalkeuze via reply keyboard -----
    const languages = {
      "🇳🇱 Nederlands": "nl",
      "🇬🇧 English": "en",
      "🇩🇪 Deutsch": "de"
    };

    if (text && languages[text]) {
      const langCode = languages[text];

      const row = getConv.get(String(chatId));
      if (!row) upsertConv.run(String(chatId), null, langCode, Date.now());
      else setLanguage.run(langCode, Date.now(), String(chatId));

      const confirmText =
        langCode === "nl"
          ? "Top, we praten Nederlands. Waar zit je hoofd nu het meeste mee?"
          : langCode === "en"
          ? "Nice, we’ll talk in English. What’s on your mind right now?"
          : "Super, wir sprechen Deutsch. Woran denkst du gerade am meisten?";

      const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: confirmText,
          reply_markup: { remove_keyboard: true }
        })
      });

      return;
    }

    // Geen tekst (voice, foto, etc.)
    if (!text) {
      await tgSendMessage(chatId, "Stuur me even in tekst wat je bedoelt, dan pak ik ’m meteen.");
      return;
    }

    // Normale message → naar Lothis (Responses)
    const reply = await lothisReply(chatId, text);
    await tgSendMessage(chatId, reply);

  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ---------- Health & root ----------
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.send("Lothis Telegram Bot is running ✨"));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis Telegram Bot running on :${PORT}`);
  console.log("Health:", `http://localhost:${PORT}/health`);
});

// ---------- Set Telegram webhook (run once manually) ----------
export async function setWebhook() {
  const webhookUrl = `${PUBLIC_BASE_URL}/telegram/${WEBHOOK_SECRET}`;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl })
  });
  const j = await r.json().catch(() => ({}));
  console.log("setWebhook:", j);
}
