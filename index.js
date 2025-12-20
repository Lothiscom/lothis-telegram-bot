import express from "express";
import Database from "better-sqlite3";
import fetch from "node-fetch";

// ---------- ENV ----------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // set in env, never hardcode
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

// Your public HTTPS URL (where Telegram can reach your server), e.g. https://bot.lothis.com
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// optional: set a secret path segment to avoid random hits
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_ASSISTANT_ID || !PUBLIC_BASE_URL) {
  console.error("Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_ASSISTANT_ID, PUBLIC_BASE_URL");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- DB (chat_id -> thread_id) ----------
const db = new Database("lothis.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    chat_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const getThread = db.prepare("SELECT thread_id FROM threads WHERE chat_id = ?");
const upsertThread = db.prepare(`
  INSERT INTO threads(chat_id, thread_id, updated_at)
  VALUES(?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    thread_id=excluded.thread_id,
    updated_at=excluded.updated_at
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
      // keep it simple; you can switch to MarkdownV2 later if you want
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Telegram sendMessage failed:", res.status, t);
  }
}

// ---------- OpenAI Assistants v2 helpers ----------
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

async function openaiCreateThread() {
  const res = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Create thread failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function openaiAddUserMessage(threadId, content) {
  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({ role: "user", content }),
  });
  if (!res.ok) throw new Error(`Add message failed: ${res.status} ${await res.text()}`);
}

async function openaiRun(threadId) {
  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID }),
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
      headers: OPENAI_HEADERS,
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

  // find most recent assistant message
  const msg = (json.data || []).find((m) => m.role === "assistant");
  if (!msg || !Array.isArray(msg.content)) return "";

  let out = "";
  for (const block of msg.content) {
    if (block?.type === "text" && block?.text?.value) out += block.text.value;
  }
  return out.trim();
}

async function lothisReply(chatId, userText) {
  // get/create thread
  let threadId = getThread.get(String(chatId))?.thread_id;
  if (!threadId) {
    threadId = await openaiCreateThread();
    upsertThread.run(String(chatId), threadId, Date.now());
  }

  await openaiAddUserMessage(threadId, userText);
  const runId = await openaiRun(threadId);
  const status = await openaiPollRun(threadId, runId);

  if (status !== "completed") {
    return "Ik ben er heel even niet lekker doorheen. Probeer het zo nog een keer.";
  }

  const text = await openaiGetLastAssistantText(threadId);
  return text || "Ik hoorde je, maar ik kreeg net even geen goede reply terug. Wil je het nog een keer zeggen?";
}

// ---------- Webhook endpoint ----------
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  // Telegram expects fast 200 OK
  res.sendStatus(200);

  try {
    const update = req.body;

    const message = update.message || update.edited_message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = message.text?.trim();

    if (!chatId) return;

    // /start
    if (text === "/start") {
      await tgSendMessage(chatId, "Hey, ik ben Lothis. Waar wil je beginnen?");
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

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

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
    body: JSON.stringify({ url: webhookUrl }),
  });
  const j = await r.json().catch(() => ({}));
  console.log("setWebhook:", j);
}