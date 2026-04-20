// src/infrastructure/whatsapp/whatsappService.js

import P from "pino";
import baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { analyzeEmail } from "../ai/openaiService.js";
import { sendIncidentAlert } from "../telegram/telegramService.js";
import { saveEmailLog } from "../../database/supabase.js";

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

const AUTH_FOLDER = "./auth_info";

const ALLOWED_GROUPS = process.env.WHATSAPP_ALLOWED_GROUPS 
  ? process.env.WHATSAPP_ALLOWED_GROUPS.split(',').map(id => id.trim()).filter(Boolean)
  : [];

console.log(`📋 ALLOWED_GROUPS loaded: ${ALLOWED_GROUPS.length} group(s)`);
let sock = null;

export async function connectWhatsApp() {
  if (sock) return sock;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  console.log("📱 Starting WhatsApp connection...");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,     
    browser: ["Unified Incident Bot", "Chrome", "1.0.0"],
    version,
    markOnlineOnConnect: false,
    // Opsional: bisa ditambah jika sering timeout
    // retryRequestDelayMs: 5000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n" + "=".repeat(60));
      console.log("📱 SCAN QR CODE DENGAN WHATSAPP → Linked Devices");
      console.log("=".repeat(60));

      // Generate QR di terminal (manual + backup)
      qrcode.generate(qr, { small: true }, (qrcodeText) => {
        console.log(qrcodeText);
        console.log("\n🔗 Atau buka WhatsApp > Settings > Linked Devices > Link a Device");
      });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected successfully!");
    }

    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log(`❌ Connection closed. Reason: ${lastDisconnect?.error?.output?.statusCode || 'unknown'}`);

      if (shouldReconnect) {
        console.log("🔄 Reconnecting in 5 seconds...");
        setTimeout(() => {
          sock = null;           // Reset agar bisa reconnect fresh
          connectWhatsApp();
        }, 5000);
      } else {
        console.log("🚫 Logged out. Silakan hapus folder auth_info dan restart.");
      }
    }
  });

  // === Bagian messages.upsert tetap sama ===
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!ALLOWED_GROUPS.includes(remoteJid)) return;

      const fromName = msg.pushName || "Unknown User";
      const groupName = remoteJid.includes('@g.us') ? "WhatsApp Group" : "WhatsApp";

      let text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || 
                 "(media)";

      if (!text || text.trim().length < 3) return;

      console.log(`\n📩 [WHATSAPP] Pesan diterima`);
      console.log(`   Dari : ${fromName}`);
      console.log(`   Isi  : ${text}`);

      const pseudoEmail = {
        id: `wa-${Date.now()}`,
        from: `${fromName} (${groupName})`,
        subject: "Pesan dari Grup WhatsApp",
        body: text,
        source: "whatsapp"
      };

      const analysis = await analyzeEmail(pseudoEmail);
      const category = (analysis.category || "").toLowerCase();
      const priority = (analysis.priority || "").toUpperCase();

      const isIncident = category.includes("incident");
      const isHighOrMedium = priority === "HIGH" || priority === "CRITICAL" || priority === "MEDIUM";

      const shouldSendToTelegram = (isIncident || isHighOrMedium) && priority !== "LOW";

      if (!shouldSendToTelegram) {
        console.log(`⏩ Skip Telegram → Priority LOW atau bukan incident serius (Category: ${category} | Priority: ${priority})`);
        await saveEmailLog(pseudoEmail, analysis, false);
        return;
      }

      const result = await sendIncidentAlert(pseudoEmail, analysis);
      
      await saveEmailLog(
        pseudoEmail, 
        analysis, 
        true, 
        result.telegramMessageId, 
        result.telegramChatId
      );

      console.log(`✅ Diteruskan ke Telegram | Category: ${category} | Priority: ${priority}`);

    } catch (err) {
      console.error("❌ Error processing WhatsApp message:", err.message);
    }
  });

  return sock;
}

export function disconnectWhatsApp() {
  if (sock) {
    sock.end();
    sock = null;
  }
}
