import dotenv from "dotenv";

dotenv.config();
console.log("process.env.EMAIL_SECURE =", process.env.EMAIL_SECURE);

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

  EMAIL_HOST: process.env.EMAIL_HOST,
  EMAIL_PORT: process.env.EMAIL_PORT
    ? parseInt(process.env.EMAIL_PORT, 10)
    : 993,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
  EMAIL_SECURE: process.env.EMAIL_SECURE === "true",

  // Grup khusus
  TG_BEACON_CHAT_ID: process.env.TG_BEACON_CHAT_ID || "-5546265953",
  TG_UTT_CHAT_ID: process.env.TG_UTT_CHAT_ID || "-1003753882093",

  // ClickUp integration (opsional)
  CLICKUP_API_KEY: process.env.CLICKUP_API_KEY || null,
  CLICKUP_LIST_ID: process.env.CLICKUP_LIST_ID || null,
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