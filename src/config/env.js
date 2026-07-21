import dotenv from "dotenv";

dotenv.config();

export const env = {
  TG_TOKEN: process.env.TG_TOKEN,
  TG_CHAT_ID: process.env.TG_CHAT_ID,
  ALLOWED_TELEGRAM_GROUPS: process.env.ALLOWED_TELEGRAM_GROUPS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  // Telegram MTProto User API
  TG_API_ID: process.env.TG_API_ID ? parseInt(process.env.TG_API_ID, 10) : null,
  TG_API_HASH: process.env.TG_API_HASH || null,
  TG_PHONE_NUMBER: process.env.TG_PHONE_NUMBER || null,
  TG_2FA_PASSWORD: process.env.TG_2FA_PASSWORD || null,
  // Grup khusus
  TG_BEACON_CHAT_ID: process.env.TG_BEACON_CHAT_ID || '-5546265953',
  TG_UTT_CHAT_ID: process.env.TG_UTT_CHAT_ID || '-1003753882093',
  // ClickUp integration (opsional)
  CLICKUP_API_KEY: process.env.CLICKUP_API_KEY || null,
  CLICKUP_LIST_ID: process.env.CLICKUP_LIST_ID || null,
  // Generic IMAP email listener
  EMAIL_IMAP_ENABLED: (process.env.EMAIL_IMAP_ENABLED || "false").toLowerCase() === "true",
  EMAIL_USER: process.env.EMAIL_USER || null,
  EMAIL_PASS: process.env.EMAIL_PASS || null,
  EMAIL_IMAP_HOST: process.env.EMAIL_IMAP_HOST || "rama.tritronik.com",
  EMAIL_IMAP_PORT: process.env.EMAIL_IMAP_PORT ? parseInt(process.env.EMAIL_IMAP_PORT, 10) : 993,
  EMAIL_IMAP_TLS: (process.env.EMAIL_IMAP_TLS || "true").toLowerCase() !== "false",
  EMAIL_TLS_REJECT_UNAUTHORIZED: (process.env.EMAIL_TLS_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false",
  EMAIL_IMAP_MAILBOX: process.env.EMAIL_IMAP_MAILBOX || "INBOX",
  EMAIL_IMAP_POLL_INTERVAL_MS: process.env.EMAIL_IMAP_POLL_INTERVAL_MS
    ? parseInt(process.env.EMAIL_IMAP_POLL_INTERVAL_MS, 10)
    : 30000,
};

if (!env.TG_TOKEN) {
  throw new Error("TG_TOKEN belum di set di file .env");
}

if (!env.TG_CHAT_ID) {
  throw new Error("TG_CHAT_ID belum di set di file .env");
}

if (!env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
  throw new Error("OPENAI_API_KEY atau GEMINI_API_KEY belum di set di file .env");
}

if (!env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL belum di set di file .env");
}

if (!env.SUPABASE_KEY) {
  throw new Error("SUPABASE_KEY belum di set di file .env");
}

if (!env.ALLOWED_TELEGRAM_GROUPS) {
  console.warn("ALLOWED_TELEGRAM_GROUPS belum di set di file .env. Bot akan merespon dari semua grup.");
  env.ALLOWED_TELEGRAM_GROUPS = "";   
}

// Telegram User API (MTProto) — opsional, warning saja jika belum diisi
if (!env.TG_API_ID || !env.TG_API_HASH) {
  console.warn("⚠️  TG_API_ID / TG_API_HASH belum di set. Telegram Personal Listener tidak akan berjalan.");
}
if (!env.TG_PHONE_NUMBER) {
  console.warn("⚠️  TG_PHONE_NUMBER belum di set. Telegram Personal Listener tidak akan berjalan.");
}

if (env.EMAIL_IMAP_ENABLED && (!env.EMAIL_USER || !env.EMAIL_PASS)) {
  console.warn("⚠️  EMAIL_IMAP_ENABLED=true tetapi EMAIL_USER / EMAIL_PASS belum diisi.");
}
