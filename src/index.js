// src/index.js

// Load environment variables pertama kali
import "dotenv/config";

import { connectWhatsApp } from "./infrastructure/whatsapp/whatsappService.js";
import { initTelegramBot } from "./infrastructure/telegram/telegramService.js";
import { startTelegramUserListener } from "./infrastructure/telegram/telegramUserListener.js";
import { startOutlookListener } from "./infrastructure/outlook/outlookService.js"; 
// import { authorize } from "./config/gmailAuth.js";
// import { forwardUnreadEmail } from "./usecases/forwardUnreadEmail.js";
import { startGmailListener } from "./infrastructure/gmail/gmailListener.js";

console.log("🚀 Unified Incident Intake System");
console.log("=====================================");

let whatsappSock = null;
let telegramUserClient = null;

async function start() {
  try {

    // console.log("📧 Testing Gmail...");
    // const auth = await authorize();
    // await forwardUnreadEmail(auth);
    // console.log("✅ Gmail berhasil dicek.");

    // Dinonaktifkan sementara untuk mencegah crash karena file credentials.json tidak ada.
    // console.log("📧 Memulai Gmail Listener...");
    // await startGmailListener();
    console.log("🤖 Memulai Telegram Bot...");
    initTelegramBot();                    // ← PENTING: Ini harus dipanggil di awal

    // console.log("📧 Memulai Outlook IMAP Listener...");
    // startOutlookListener();

    console.log("📱 Memulai WhatsApp Connection...");
    whatsappSock = await connectWhatsApp();

    console.log("📱 Memulai Telegram Personal Account Listener (MTProto)...");
    telegramUserClient = await startTelegramUserListener(); // ← Hanya minta OTP jika session belum ada

    console.log("\n✅ Semua sistem berhasil dijalankan!");
    console.log("   • Telegram Bot (dengan Menu & AI)");
    if (telegramUserClient) {
      console.log("   • Telegram Personal DM Listener (MTProto)");
    }
    console.log("   • WhatsApp Listener");
    
    console.log("=====================================");

    console.log("💡 Ketik /menu di Telegram untuk membuka menu utama");

  } catch (err) {
    console.error("❌ Gagal memulai sistem:", err.message);
    console.error(err);
    process.exit(1);
  }
}

// ====================== GRACEFUL SHUTDOWN ======================
process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT diterima. Menutup sistem...");

  try {
    if (whatsappSock) {
      console.log("📴 Menutup WhatsApp connection...");
      whatsappSock.end();
    }

    if (telegramUserClient) {
      console.log("📴 Menutup Telegram User connection...");
      await telegramUserClient.disconnect().catch(() => {});
    }

    // Telegram Bot tidak perlu disconnect manual karena polling akan ikut mati
    console.log("👋 Semua service telah dihentikan.");
  } catch (err) {
    console.error("Error saat shutdown:", err.message);
  }

  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM diterima. Menutup sistem...");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err.message);
  console.error(err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

// Jalankan sistem
start();