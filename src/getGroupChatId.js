import 'dotenv/config';  // load TG_TOKEN dari .env
import TelegramBot from "node-telegram-bot-api";

const bot = new TelegramBot(process.env.TG_TOKEN, { polling: true });

console.log("Bot aktif, kirim pesan di group untuk cek chat_id...");

bot.on("message", (msg) => {
  console.log("Chat ID:", msg.chat.id);
});