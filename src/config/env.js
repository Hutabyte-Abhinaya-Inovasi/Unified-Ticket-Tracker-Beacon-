import dotenv from "dotenv";

dotenv.config();

export const env = {
  TG_TOKEN: process.env.TG_TOKEN,
  TG_CHAT_ID: process.env.TG_CHAT_ID,
  ALLOWED_TELEGRAM_GROUPS: process.env.ALLOWED_TELEGRAM_GROUPS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
};

if (!env.TG_TOKEN) {
  throw new Error("TG_TOKEN belum di set di file .env");
}

if (!env.TG_CHAT_ID) {
  throw new Error("TG_CHAT_ID belum di set di file .env");
}

if (!env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY belum di set di file .env");
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