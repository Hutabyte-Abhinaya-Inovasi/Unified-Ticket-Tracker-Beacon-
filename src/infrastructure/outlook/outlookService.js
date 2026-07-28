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
let lastSeenUid = null;

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
  imap.openBox("INBOX", false, (err, box) => {
    if (err) {
      console.error("❌ Gagal buka INBOX:", err.message);
      return scheduleReconnect();
    }

    console.log("📬 INBOX opened");

    // Saat program pertama hidup:
    // catat UID terakhir yang sudah ada di mailbox.
    // Jangan proses email-email lama.
    lastSeenUid = box.uidnext - 1;

    console.log(`📌 Mulai listen setelah UID: ${lastSeenUid}`);
    console.log("👂 Menunggu email BARU...");

    imap.on("mail", () => {
      fetchNewEmails();
    });
  });
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getEmailBody(parsed) {
  // Prioritas 1: plain text
  if (parsed.text && parsed.text.trim()) {
    return parsed.text.trim();
  }

  // Prioritas 2: HTML
  if (parsed.html) {
    const html =
      typeof parsed.html === "string"
        ? parsed.html
        : parsed.html.toString();

    const text = htmlToText(html);

    if (text) {
      return text;
    }
  }

  // Email memang tidak mempunyai body yang bisa dibaca
  return "(Email tidak memiliki isi teks)";
}

function fetchNewEmails() {
  if (lastSeenUid === null) {
    console.log("⚠️ lastSeenUid belum tersedia.");
    return;
  }

  const startUid = lastSeenUid + 1;

  console.log(`📨 Mengecek email baru mulai UID ${startUid}...`);

  imap.search(
    [["UID", `${startUid}:*`]],
    (err, results) => {
      if (err) {
        console.error("❌ Gagal mencari email baru:", err.message);
        return;
      }

      if (!results?.length) {
        console.log("📭 Tidak ada email baru.");
        return;
      }

      console.log(`📬 Ditemukan ${results.length} email baru`);

      const f = imap.fetch(results, {
        bodies: "",
        markSeen: false,
      });

      f.on("message", (msg) => {
        let currentUid = null;

        msg.once("attributes", (attrs) => {
          currentUid = attrs.uid;
        });

        msg.on("body", async (stream) => {
          try {
            const parsed = await simpleParser(stream);

            console.log("===== EMAIL PARSED =====");
            console.log("Subject :", parsed.subject);
            console.log("From    :", parsed.from?.text);
            console.log("Text    :", parsed.text);
            console.log("HTML    :", parsed.html);
            console.log("========================");

            console.log("📨 EMAIL BARU");

            await saveRawIntakeMessage({
              source_channel: "email",

              source_ref:
                parsed.messageId ||
                `imap-${currentUid}`,

              sender:
                parsed.from?.text ||
                parsed.from?.value?.[0]?.name ||
                parsed.from?.value?.[0]?.address ||
                "Unknown",

              thread_ref:
                parsed.messageId ||
                null,

              received_at:
                parsed.date || new Date(),

              body_text:
                getEmailBody(parsed),

              attachments: {
                count: parsed.attachments?.length || 0,
              },

              raw_payload: parsed,

              // Pengaman duplikat
              idempotency_key:
                `email-${parsed.messageId || currentUid}`,
            });

            console.log("✅ Email disimpan ke intake_message");

          } catch (err) {
            console.error(
              "❌ Error processing email:",
              err.message
            );
          }
        });

        msg.once("end", () => {
          if (currentUid && currentUid > lastSeenUid) {
            lastSeenUid = currentUid;
          }
        });
      });

      f.once("error", (err) => {
        console.error("❌ Fetch error:", err.message);
      });

      f.once("end", () => {
        console.log("✅ Selesai memproses email baru");
        console.log(`👂 Menunggu email setelah UID ${lastSeenUid}...`);
      });
    }
  );
}


export function startOutlookListener() {
  connectIMAP();
}

export function stopOutlookListener() {
  if (imap) imap.end();
}

// untuk email dari outlook diabaikan saja ! 