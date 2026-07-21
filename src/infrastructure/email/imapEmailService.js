// src/infrastructure/email/imapEmailService.js
// Listener email generik via IMAP (SSL/TLS).
// Alur: UNSEEN email -> intake_message -> processRawMessage -> tandai Seen.

import Imap from "imap";
import { simpleParser } from "mailparser";
import { htmlToText } from "html-to-text";

import { env } from "../../config/env.js";
import { saveRawIntakeMessage } from "../../database/supabase.js";
import { processRawMessage } from "../../usecases/processRawMessage.js";

let imap = null;
let reconnectTimer = null;
let pollTimer = null;
let reconnectAttempts = 0;
let stopping = false;
let fetching = false;

const inFlightMessageIds = new Set();

function normalizeMessageId(value) {
  if (!value) return null;
  return String(value).trim().replace(/^<|>$/g, "");
}

function normalizeReferences(value) {
  if (!value) return [];
  const refs = Array.isArray(value) ? value : String(value).split(/\s+/);
  return refs.map(normalizeMessageId).filter(Boolean);
}

function extractAddress(addressObject) {
  const first = addressObject?.value?.[0];
  if (!first) return null;
  return first.address || null;
}

function getBodyText(parsed) {
  const plainText = parsed.text?.trim();
  if (plainText) return plainText;

  if (parsed.html) {
    return htmlToText(String(parsed.html), {
      wordwrap: 130,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { ignoreHref: true } },
      ],
    }).trim();
  }

  return "(Email tidak memiliki isi teks)";
}

function getReconnectDelay() {
  const base = Math.min(5000 * (2 ** reconnectAttempts), 60000);
  return base + Math.floor(Math.random() * 1000);
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pollTimer) clearInterval(pollTimer);
  reconnectTimer = null;
  pollTimer = null;
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;

  const delay = getReconnectDelay();
  console.log(`⏳ IMAP reconnect dalam ${Math.round(delay / 1000)} detik...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts += 1;
    connectImap();
  }, delay);
}

function markSeen(uid) {
  return new Promise((resolve, reject) => {
    if (!imap) return reject(new Error("IMAP belum terhubung"));
    imap.addFlags(uid, "\\Seen", (err) => (err ? reject(err) : resolve()));
  });
}

async function processEmail(parsed, uid) {
  const messageId = normalizeMessageId(parsed.messageId) || `imap-${uid}-${Date.now()}`;
  if (inFlightMessageIds.has(messageId)) return;
  inFlightMessageIds.add(messageId);

  try {
    const references = normalizeReferences(parsed.references);
    const inReplyTo = normalizeMessageId(parsed.inReplyTo);
    const threadRoot = references[0] || inReplyTo || messageId;
    const senderEmail = extractAddress(parsed.from);
    const senderText = parsed.from?.text || senderEmail || "Unknown Sender";
    const recipientText = parsed.to?.text || env.EMAIL_USER;
    const bodyText = getBodyText(parsed);
    const subject = parsed.subject?.trim() || "(Tanpa Subjek)";
    const receivedAt = parsed.date instanceof Date && !Number.isNaN(parsed.date.valueOf())
      ? parsed.date.toISOString()
      : new Date().toISOString();

    const attachments = (parsed.attachments || []).map((item) => ({
      filename: item.filename || null,
      contentType: item.contentType || null,
      size: item.size || null,
      contentId: item.contentId || null,
    }));

    console.log("\n📧 Email IMAP diterima");
    console.log(`   From    : ${senderText}`);
    console.log(`   Subject : ${subject}`);
    console.log(`   UID     : ${uid}`);

    const rawPayload = {
      group_name: subject,
      mailbox: env.EMAIL_IMAP_MAILBOX,
      message_id: messageId,
      in_reply_to: inReplyTo,
      references,
      from_email: senderEmail,
      to: recipientText,
      subject,
      uid,
    };

    const raw = await saveRawIntakeMessage({
      source_channel: "email",
      source_ref: `email:${threadRoot}`,
      sender: senderText,
      thread_ref: inReplyTo,
      received_at: receivedAt,
      body_text: bodyText,
      attachments: attachments.length ? attachments : null,
      raw_payload: rawPayload,
      idempotency_key: messageId,
    });

    if (!raw?.id) {
      // Umumnya berarti Message-ID sudah pernah diproses (constraint idempotency).
      console.log(`   ⏩ Email dilewati karena sudah tersimpan/duplikat: ${messageId}`);
      await markSeen(uid);
      return;
    }

    // Pastikan processor memperoleh semua field walau respons insert DB dibatasi.
    await processRawMessage({
      ...raw,
      source_channel: "email",
      source_ref: `email:${threadRoot}`,
      sender: senderText,
      thread_ref: inReplyTo,
      received_at: receivedAt,
      body_text: bodyText,
      attachments: attachments.length ? attachments : null,
      raw_payload: rawPayload,
      idempotency_key: messageId,
    });

    await markSeen(uid);
    console.log(`   ✅ Email selesai diproses dan ditandai Seen: ${messageId}`);
  } catch (err) {
    // Email tetap UNSEEN agar dapat dicoba lagi pada polling berikutnya.
    console.error(`❌ Gagal memproses email IMAP UID ${uid}:`, err.message);
  } finally {
    inFlightMessageIds.delete(messageId);
  }
}

function fetchUnread() {
  if (!imap || fetching || stopping) return;
  fetching = true;

  imap.search(["UNSEEN"], (searchErr, uids) => {
    if (searchErr) {
      fetching = false;
      console.error("❌ Gagal mencari email UNSEEN:", searchErr.message);
      return;
    }

    if (!uids?.length) {
      fetching = false;
      return;
    }

    console.log(`📬 Ditemukan ${uids.length} email unread di ${env.EMAIL_IMAP_MAILBOX}`);

    const fetcher = imap.fetch(uids, {
      bodies: "",
      markSeen: false,
      struct: true,
    });

    const tasks = [];

    fetcher.on("message", (msg, seqno) => {
      let uid = seqno;
      let parsedPromise = null;

      msg.once("attributes", (attrs) => {
        uid = attrs.uid || seqno;
      });

      msg.on("body", (stream) => {
        parsedPromise = simpleParser(stream);
      });

      msg.once("end", () => {
        const task = (parsedPromise || Promise.reject(new Error("Body email kosong")))
          .then((parsed) => processEmail(parsed, uid))
          .catch((err) => {
            console.error(`❌ Gagal parsing email UID ${uid}:`, err.message);
          });
        tasks.push(task);
      });
    });

    fetcher.once("error", (err) => {
      console.error("❌ IMAP fetch error:", err.message);
    });

    fetcher.once("end", async () => {
      await Promise.allSettled(tasks);
      fetching = false;
    });
  });
}

function openInbox() {
  imap.openBox(env.EMAIL_IMAP_MAILBOX, false, (err) => {
    if (err) {
      console.error(`❌ Gagal membuka mailbox ${env.EMAIL_IMAP_MAILBOX}:`, err.message);
      scheduleReconnect();
      return;
    }

    console.log(`📬 IMAP mailbox aktif: ${env.EMAIL_IMAP_MAILBOX}`);

    // Replay email unread saat aplikasi baru hidup.
    fetchUnread();

    // Event cepat saat server memberi notifikasi email baru.
    imap.on("mail", fetchUnread);

    // Polling cadangan apabila server tidak konsisten mengirim event "mail".
    if (!pollTimer) {
      pollTimer = setInterval(fetchUnread, env.EMAIL_IMAP_POLL_INTERVAL_MS);
    }
  });
}

function connectImap() {
  if (stopping) return;

  if (imap) {
    try {
      imap.removeAllListeners();
      imap.end();
    } catch {}
  }

  console.log(`📧 Menghubungkan IMAP ${env.EMAIL_IMAP_HOST}:${env.EMAIL_IMAP_PORT}...`);

  imap = new Imap({
    user: env.EMAIL_USER,
    password: env.EMAIL_PASS,
    host: env.EMAIL_IMAP_HOST,
    port: env.EMAIL_IMAP_PORT,
    tls: env.EMAIL_IMAP_TLS,
    tlsOptions: {
      rejectUnauthorized: env.EMAIL_TLS_REJECT_UNAUTHORIZED,
      servername: env.EMAIL_IMAP_HOST,
    },
    authTimeout: 30000,
    connTimeout: 30000,
    keepalive: {
      interval: 10000,
      idleInterval: 300000,
      forceNoop: true,
    },
  });

  imap.once("ready", () => {
    reconnectAttempts = 0;
    console.log(`✅ IMAP login berhasil sebagai ${env.EMAIL_USER}`);
    openInbox();
  });

  imap.on("error", (err) => {
    if (stopping) return;
    console.error("❌ IMAP error:", err.message);
  });

  imap.once("close", (hadError) => {
    if (stopping) return;
    console.warn(`📴 IMAP connection ditutup${hadError ? " karena error" : ""}.`);
    scheduleReconnect();
  });

  imap.once("end", () => {
    if (stopping) return;
    console.warn("📴 IMAP connection berakhir.");
  });

  imap.connect();
}

export function startImapEmailListener() {
  if (!env.EMAIL_IMAP_ENABLED) {
    console.log("⏭️  IMAP Email Listener nonaktif (EMAIL_IMAP_ENABLED=false).");
    return false;
  }

  if (!env.EMAIL_USER || !env.EMAIL_PASS) {
    console.warn("⚠️  IMAP Email Listener dilewati: EMAIL_USER/EMAIL_PASS belum diisi.");
    return false;
  }

  stopping = false;
  connectImap();
  return true;
}

export function stopImapEmailListener() {
  stopping = true;
  clearTimers();
  inFlightMessageIds.clear();

  if (imap) {
    try {
      imap.removeAllListeners("mail");
      imap.end();
    } catch (err) {
      console.warn("⚠️  Gagal menutup IMAP secara normal:", err.message);
    }
  }

  imap = null;
  console.log("📴 IMAP Email Listener dihentikan.");
}
