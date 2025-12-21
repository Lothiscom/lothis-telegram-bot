import express from "express";
import Database from "better-sqlite3";
import fetch from "node-fetch";

// ---------- ENV ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

// Geen animatie voor nu
const WELCOME_ANIMATION_URL = process.env.WELCOME_ANIMATION_URL || "";

// Afbeelding als welcome card
const WELCOME_IMAGE_URL =
  process.env.WELCOME_IMAGE_URL ||
  "http://lothis.com/wp-content/uploads/2025/12/lotus-tg-animation.jpg";

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_ASSISTANT_ID || !PUBLIC_BASE_URL) {
  console.error(
    "Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_ASSISTANT_ID, PUBLIC_BASE_URL"
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- DB (chat_id -> thread_id + language) ----------
const db = new Database("lothis.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    chat_id    TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL,
    language   TEXT,
    updated_at INTEGER NOT NULL
  );
`);

const getThread = db.prepare("SELECT thread_id, language FROM threads WHERE chat_id = ?");
const upsertThread = db.prepare(`
  INSERT INTO threads (chat_id, thread_id, language, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    thread_id  = excluded.thread_id,
    language   = COALESCE(excluded.language, threads.language),
    updated_at = excluded.updated_at
`);

const setLanguage = db.prepare(`
  UPDATE threads
  SET language = ?
  WHERE chat_id = ?
`);

const getLanguage = db.prepare(`
  SELECT language FROM threads WHERE chat_id = ?
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

// Static image fallback (we gebruiken dit alleen als animatie er niet is)
async function tgSendPhotoWithButtons(chatId, caption, inlineKeyboard) {
  if (!WELCOME_IMAGE_URL) {
    // geen image ingesteld → val terug op tekst
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

// ---------- OpenAI Assistants v2 helpers ----------
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2"
};

async function openaiCreateThread() {
  const res = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({})
  });
  if (!res.ok) throw new Error(`Create thread failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function openaiAddUserMessage(threadId, content) {
  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({ role: "user", content })
  });
  if (!res.ok) throw new Error(`Add message failed: ${res.status} ${await res.text()}`);
}

async function openaiRun(threadId, lang) {
  const body = lang
    ? {
        assistant_id: OPENAI_ASSISTANT_ID,
        instructions: `Respond in language: ${lang}`
      }
    : {
        assistant_id: OPENAI_ASSISTANT_ID
      };

  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Run failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function openaiPollRun(threadId, runId, maxMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
      method: "GET",
      headers: OPENAI_HEADERS
    });
    if (!res.ok) throw new Error(`Poll failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const status = json.status;

    if (status === "completed") return "completed";
    if (status === "failed" || status === "cancelled" || status === "expired") return status;

    await new Promise((r) => setTimeout(r, 500));
  }
  return "timeout";
}

async function openaiGetLastAssistantText(threadId) {
  const res = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?limit=10&order=desc`,
    { method: "GET", headers: OPENAI_HEADERS }
  );
  if (!res.ok) throw new Error(`Get messages failed: ${res.status} ${await res.text()}`);
  const json = await res.json();

  const msg = (json.data || []).find((m) => m.role === "assistant");
  if (!msg || !Array.isArray(msg.content)) return "";

  let out = "";
  for (const block of msg.content) {
    if (block?.type === "text" && block?.text?.value) out += block.text.value;
  }
  return out.trim();
}

async function lothisReply(chatId, userText) {
  let row = getThread.get(String(chatId));
  let threadId = row?.thread_id;
  const existingLang = row?.language || null;

  if (!threadId) {
    threadId = await openaiCreateThread();
    upsertThread.run(String(chatId), threadId, existingLang, Date.now());
  }

  const lang = existingLang || getLanguage.get(String(chatId))?.language || null;
  const content = lang ? `[LANG:${lang}] ${userText}` : userText;

  await openaiAddUserMessage(threadId, content);
  const runId = await openaiRun(threadId, lang);
  const status = await openaiPollRun(threadId, runId);

  if (status !== "completed") {
    return "Ik ben er heel even niet lekker doorheen. Probeer het zo nog een keer.";
  }

  const text = await openaiGetLastAssistantText(threadId);
  return text || "Ik hoorde je, maar ik kreeg net even geen goede reply terug. Wil je het nog een keer zeggen?";
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
    [
      {
        text: "✨ What is Lothis?",
        url: "https://lothis.com"
      }
    ]
  ];

  // Eerst proberen: animatie (GIF/MP4)
  if (WELCOME_ANIMATION_URL) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendAnimation`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        animation: WELCOME_ANIMATION_URL,
        caption,
        reply_markup: { inline_keyboard: inlineKeyboard }
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("Telegram sendAnimation failed:", res.status, t);
      // Fallback op static image/tekst
      await tgSendPhotoWithButtons(chatId, caption, inlineKeyboard);
    }
    return;
  }

  // Geen animatie ingesteld → fallback naar static
  await tgSendPhotoWithButtons(chatId, caption, inlineKeyboard);
}

// ---------- Callback handler ----------
async function handleCallback(update) {
  const callback = update.callback_query;
  if (!callback) return;

  const chatId = callback.message?.chat?.id;
  const data = callback.data;

  if (!chatId || !data) return;

  // Stop de Telegram spinner
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
      await tgSendMessage(
        chatId,
        "Kies eerst even een taal, dan kunnen we echt goed praten. 🙂"
      );
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

    // ----- /start: unieke animated welcome card -----
    if (text === "/start") {
      let row = getThread.get(String(chatId));
      if (!row?.thread_id) {
        const threadId = await openaiCreateThread();
        upsertThread.run(String(chatId), threadId, row?.language || null, Date.now());
      }

      await sendWelcomeCard(chatId);
      return;
    }

    // ----- taalkeuze via reply keyboard -----
    const languages = {
      "🇳🇱 Nederlands": "nl",
      "🇬🇧 English": "en",
      "🇩🇪 Deutsch": "de"
    };

    if (languages[text]) {
      const langCode = languages[text];

      let row = getThread.get(String(chatId));
      if (!row?.thread_id) {
        const newThread = await openaiCreateThread();
        upsertThread.run(String(chatId), newThread, langCode, Date.now());
      } else {
        // alleen taal bijwerken
        setLanguage.run(langCode, String(chatId));
      }

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
          reply_markup: {
            remove_keyboard: true
          }
        })
      });

      return;
    }

    // Geen tekst (voice, foto, etc.)
    if (!text) {
      await tgSendMessage(chatId, "Stuur me even in tekst wat je bedoelt, dan pak ik ’m meteen.");
      return;
    }

    // Normale message → naar Lothis
    const reply = await lothisReply(chatId, text);
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ---------- Health & root ----------
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  res.send("Lothis Telegram Bot is running ✨");
});

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
