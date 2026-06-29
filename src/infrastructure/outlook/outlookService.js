// src/infrastructure/outlook/outlookService.js

import Imap from "imap";
import { simpleParser } from "mailparser";
import { analyzeEmail } from "../ai/openaiService.js";
import { sendIncidentAlert } from "../telegram/telegramService.js";
import { saveEmailLog } from "../../database/supabase.js";
import { env } from "../../config/env.js";

const imapConfig = {
  user: env.EMAIL_USER,
  password: env.EMAIL_PASS,
  host: "rama.tritronik.com",
  port: 993,
  tls: true,
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

function connectIMAP() {
  console.log("🚀 Connecting to Outlook IMAP...");

  if (imap) {
    try { imap.end(); } catch {}
  }

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
    if (err || !results?.length) return;

    const f = imap.fetch(results, { bodies: "", markSeen: true });

    f.on("message", (msg, seqno) => {
      msg.on("body", async (stream) => {
        try {
          const parsed = await simpleParser(stream);
          const emailData = {
            id: parsed.messageId || `${Date.now()}-${seqno}`,
            from: parsed.from?.text || "Unknown",
            subject: parsed.subject || "(No Subject)",
            body: parsed.text || "",
          };

          console.log(`📨 Email masuk: ${emailData.subject}`);

          const analysis = await analyzeEmail(emailData);
          const category = (analysis.category || "").toLowerCase();
          const priority = (analysis.priority || "").toUpperCase();

          if (!category.includes("incident") || priority === "LOW") {
            await saveEmailLog(emailData, analysis, false);
            return;
          }

          await sendIncidentAlert(emailData, analysis);

        } catch (err) {
          console.error("❌ Error processing email:", err.message);
        }
      });
    });
  });
}

export function startOutlookListener() {
  connectIMAP();
}

export function stopOutlookListener() {
  if (imap) imap.end();
}

