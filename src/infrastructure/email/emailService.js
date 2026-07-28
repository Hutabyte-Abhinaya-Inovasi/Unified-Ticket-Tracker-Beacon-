import Imap from "imap";
import { simpleParser } from "mailparser";
import { env } from "../../config/env.js";
import { saveRawIntakeMessage } from "../../database/supabase.js";

const imapConfig = {
  user: env.EMAIL_USER,
  password: env.EMAIL_PASS,
  host: env.EMAIL_HOST,
  port: Number(env.EMAIL_PORT || 993),
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
  console.log(`⏳ Reconnecting IMAP in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts + 1})`);

  reconnectTimer = setTimeout(() => {
    reconnectAttempts++;
    connectIMAP();
  }, delay);
}

function connectIMAP() {
  if (!env.EMAIL_HOST || !env.EMAIL_USER || !env.EMAIL_PASS) {
    console.warn("⚠️ Kredensial IMAP belum lengkap di .env (EMAIL_HOST, EMAIL_USER, EMAIL_PASS). Listener tidak dijalankan.");
    return;
  }

  console.log("🚀 Connecting to IMAP Email Listener...", {
    host: imapConfig.host,
    port: imapConfig.port,
    tls: imapConfig.tls,
    user: imapConfig.user,
  });

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
    if (err.message?.includes("authentication") || err.message?.includes("login")) {
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
  imap.openBox("INBOX", false, (err, box) => {
    if (err) {
      console.error("❌ Gagal buka INBOX:", err.message);
      return scheduleReconnect();
    }

    console.log("📬 INBOX opened");

    // Catat UID terakhir di mailbox agar tidak memproses email lama saat startup
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
  if (parsed.text && parsed.text.trim()) {
    return parsed.text.trim();
  }

  if (parsed.html) {
    const html = typeof parsed.html === "string" ? parsed.html : parsed.html.toString();
    const text = htmlToText(html);
    if (text) return text;
  }

  return "(Email tidak memiliki isi teks)";
}

function fetchNewEmails() {
  if (lastSeenUid === null) {
    console.log("⚠️ lastSeenUid belum tersedia.");
    return;
  }

  const startUid = lastSeenUid + 1;
  console.log(`📨 Mengecek email baru mulai UID ${startUid}...`);

  imap.search([["UID", `${startUid}:*`]], (err, results) => {
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
          console.log("========================");

          console.log("📨 EMAIL BARU DITERIMA");

          const sender = parsed.from?.text || parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || "Unknown";

          await saveRawIntakeMessage({
            source_channel: "email",
            source_ref: parsed.messageId || `imap-${currentUid}`,
            sender: sender,
            thread_ref: parsed.messageId || null,
            received_at: parsed.date || new Date(),
            body_text: getEmailBody(parsed),
            attachments: {
              count: parsed.attachments?.length || 0,
            },
            raw_payload: parsed,
            idempotency_key: `email-${parsed.messageId || currentUid}`,
          });

          console.log("✅ Email disimpan ke intake_message");
        } catch (err) {
          console.error("❌ Error processing email:", err.message);
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
  });
}

export function startEmailListener() {
  connectIMAP();
}

export function stopEmailListener() {
  if (imap) imap.end();
}
