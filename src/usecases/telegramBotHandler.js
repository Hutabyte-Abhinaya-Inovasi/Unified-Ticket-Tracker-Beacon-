import TelegramBot from "node-telegram-bot-api";
import { env } from "../config/env.js";
import { chatWithAI } from "../infrastructure/ai/openaiService.js";

export function startTelegramBot() {
  const bot = new TelegramBot(env.TG_TOKEN, { polling: true });

  console.log("🤖 Telegram AI Bot aktif...");

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const botUsername = (await bot.getMe()).username; // ambil username bot

    if (!text) return;

    // Grup → hanya respon jika mention bot
    if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
      // cek mention
      if (!text.includes(`@${botUsername}`)) return;

      // hapus mention dari text agar AI lebih bersih
      const cleanText = text.replace(`@${botUsername}`, "").trim();

      const response = await chatWithAI(cleanText);
      await bot.sendMessage(chatId, response, { parse_mode: "HTML" });
      return;
    }

    // Private chat → langsung respon
    if (msg.chat.type === "private") {
      const response = await chatWithAI(text);
      await bot.sendMessage(chatId, response, { parse_mode: "HTML" });
    }
  });
}