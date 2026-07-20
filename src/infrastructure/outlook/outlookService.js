// src/infrastructure/outlook/outlookService.js

import Imap from "imap";
import { simpleParser } from "mailparser";
//import { analyzeEmail } from "../ai/openaiService.js";
//import { sendIncidentAlert } from "../telegram/telegramService.js";
//import { saveEmailLog } from "../../database/supabase.js";
import { env } from "../../config/env.js";
import { saveRawIntakeMessage } from "../../database/supabase.js";
const imapConfig = {
  user: env.EMAIL_USER,
  password: env.EMAIL_PASS,
  host: env.EMAIL_HOST,
  port: Number(env.EMAIL_PORT),
  tls: env.EMAIL_SECURE,
  tlsOptions: { rejectUnauthorized: true },  
  authTimeout: 30000,
  keepalive: true,
  keepaliveInterval: 30000,
};

let imap = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function getReconnectDelay() {
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
  return delay + Math.random() * 1000;
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = getReconnectDelay();
  console.log(`⏳ Reconnecting IMAP in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts + 1})`);
  
  reconnectTimer = setTimeout(() => {
    reconnectAttempts++;
    connectIMAP();
  }, delay);
}

console.log("IMAP Config:", {
  host: imapConfig.host,
  port: imapConfig.port,
  tls: imapConfig.tls,
  user: imapConfig.user,
});

function connectIMAP() {
  console.log("🚀 Connecting to Outlook IMAP...");

  if (imap) {
    try { imap.end(); } catch {}
  }
  
  console.log("env.EMAIL_SECURE =", env.EMAIL_SECURE);
  imap = new Imap(imapConfig);

  imap.once("ready", () => {
    console.log("✅ IMAP Connected successfully!");
    reconnectAttempts = 0;
    openInbox();
  });

  imap.on("error", (err) => {
    console.error("❌ IMAP Error:", err.message);
    if (err.message.includes("authentication") || err.message.includes("login")) {
      console.error("💡 Saran: Pastikan menggunakan App Password (bukan password biasa) di .env");
    }
     console.error("message:", err?.message);
    console.error("source:", err?.source);
    console.error("code:", err?.code);
    console.error("stack:", err?.stack);
    scheduleReconnect();
  });

  imap.on("end", () => {
    console.log("📴 IMAP connection ended");
    scheduleReconnect();
  });

  imap.connect();
}

function openInbox() {
  imap.openBox("INBOX", false, (err) => {
    if (err) {
      console.error("❌ Gagal buka INBOX:", err.message);
      return scheduleReconnect();
    }
    console.log("📬 INBOX opened");
    fetchUnread();
    imap.on("mail", () => fetchUnread());
  });
}

function fetchUnread() {
  imap.search(["UNSEEN"], (err, results) => {
    if (err) {
        console.error(err);
        return;
    }

    console.log("UNSEEN results:", results);

    if (!results?.length) {
        console.log("Tidak ada email UNSEEN");
        return;
    }

    const f = imap.fetch(results, {
      bodies: "",
      markSeen: false, // ubah ke true nanti kalau sudah production
    });

    f.on("message", (msg, seqno) => {
      msg.on("body", async (stream) => {
        try {
          const parsed = await simpleParser(stream);
          console.log("📨 Email masuk");
          console.log("Subject :", parsed.subject);
          console.log("From    :", parsed.from?.text);
          console.log("Date    :", parsed.date);
          await saveRawIntakeMessage({
              source_channel: "email",
              source_ref: parsed.messageId,
              sender: parsed.from?.text || "Unknown",
              thread_ref: parsed.messageId,
              received_at: parsed.date,
              body_text: parsed.text,
              attachments: {
                  count: parsed.attachments?.length || 0,
              },
              raw_payload: parsed,
              idempotency_key: `email-${parsed.messageId}`,
          });
          console.log("✅ Email berhasil disimpan ke raw_intake_messages");
        } catch (err) {
          console.error("❌ Error processing email:", err.message);
        }
      });
    });
    f.once("error", (err) => {
      console.error("Fetch error:", err);
    });

    f.once("end", () => {
      console.log("✅ Selesai memproses batch email");
    });

  });


}


export function startOutlookListener() {
  connectIMAP();
}

export function stopOutlookListener() {
  if (imap) imap.end();
}

// untuk email dari outlook diabaikan saja ! 