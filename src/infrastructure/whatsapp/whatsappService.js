// src/infrastructure/whatsapp/whatsappService.js
import P from "pino";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { saveRawIntakeMessage, supabase } from "../../database/supabase.js";
import { useSupabaseAuthState } from "./supabaseAuthState.js";
import { processRawMessage } from "../../usecases/processRawMessage.js";

const AUTH_FOLDER = "./auth_info";

const groupCache = new Map();

// ─── Grup yang dimonitor ──────────────────────────────────────────────────────
// Baca dari env variable ALLOWED_WHATSAPP_GROUPS (koma-separated)
// Fallback ke hardcoded jika env belum diisi
const ALLOWED_GROUPS = new Set(
  (process.env.ALLOWED_WHATSAPP_GROUPS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

if (ALLOWED_GROUPS.size === 0) {
  [
    "120363021244940257@g.us",
    "628111188176-1519023923@g.us",
    "628118821733-1553603674@g.us",
    "628118501322-1540806627@g.us",
    "628118820105-1549007507@g.us",
  ].forEach(id => ALLOWED_GROUPS.add(id));
  console.warn("⚠️  ALLOWED_WHATSAPP_GROUPS tidak diset di .env, menggunakan fallback hardcoded.");
}

console.log(`📋 ALLOWED_GROUPS loaded: ${ALLOWED_GROUPS.size} group(s)`);

let sock = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractMessageText(msg) {
  const message = msg.message;
  if (!message) return "";

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  ).trim();
}

function isGroup(remoteJid = "") {
  return remoteJid.endsWith("@g.us");
}

function getGroupSubject(remoteJid) {
  if (!isGroup(remoteJid)) return "Private Chat";
  const metadata = groupCache.get(remoteJid);
  return metadata?.subject?.trim() || "Unknown WhatsApp Group";
}

// ─── Connect ──────────────────────────────────────────────────────────────────

export async function connectWhatsApp() {
  if (sock) return sock;

  let authState;
  if (process.env.USE_SUPABASE_AUTH === "true") {
    console.log("📱 Menggunakan Supabase Auth State untuk WhatsApp...");
    authState = await useSupabaseAuthState(supabase, "whatsapp-session");
  } else {
    console.log("📱 Menggunakan Local File Auth State untuk WhatsApp...");
    authState = await useMultiFileAuthState(AUTH_FOLDER);
  }

  const { state, saveCreds } = authState;
  const { version } = await fetchLatestBaileysVersion();

  console.log("📱 Starting WhatsApp connection...");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    browser: ["Unified Incident Bot", "Chrome", "1.0.0"],
    version,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Connection state ───────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n" + "=".repeat(60));
      console.log("📱 SCAN QR CODE DENGAN WHATSAPP");
      console.log("=".repeat(60));
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected successfully!");

      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log("\n📋 GROUP TERDETEKSI:");
        Object.entries(groups).forEach(([id, group]) => {
          groupCache.set(id, group);
          console.log(`• ${group.subject || 'No Subject'} -> ${id}`);
        });
      } catch (err) {
        console.log("⚠️ Gagal load group list:", err.message);
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      console.log(`❌ WA disconnected (${code || "unknown"})`);

      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
        sock = null;
        setTimeout(connectWhatsApp, 5000);
      } else {
        console.log("🚫 Logged out");
      }
    }
  });

  // ── Group metadata cache update ────────────────────────────────────────────
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id && update.subject !== undefined) {
        const current = groupCache.get(update.id) || {};
        groupCache.set(update.id, { ...current, ...update });
        console.log(`🔄 Group subject updated: ${update.subject} (${update.id})`);
      }
    }
  });

  // ── Incoming messages ──────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;
      if (!messages?.length) return;

      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid || "";
      const isGrp = isGroup(remoteJid);

      // Grup harus terdaftar di ALLOWED_GROUPS; pesan DM (japri) selalu lolos
      if (isGrp && !ALLOWED_GROUPS.has(remoteJid)) return;

      const senderName = msg.pushName || "Unknown User";
      const text = extractMessageText(msg);
      if (!text) return;

      console.log("\n📩 WhatsApp Message Received");
      console.log(`Group : ${getGroupSubject(remoteJid)}`);
      console.log(`From  : ${senderName}`);
      console.log(`Text  : ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

      // Ambil quoted message ID (untuk thread_ref)
      const quotedStanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null;
      const participantId  = msg.key.participant || msg.key.remoteJid;

      // ── STEP 1: Simpan pesan mentah ke intake_message ──────────────
      // Terjadi untuk SETIAP pesan sebelum diproses AI apapun.
      const raw = await saveRawIntakeMessage({
        source_channel:  isGrp ? 'wa_group' : 'wa_dm',
        source_ref:      remoteJid,
        sender:          participantId
                           ? `${senderName} (${participantId})`
                           : senderName,
        thread_ref:      quotedStanzaId,                  // ← ID pesan yang di-quote
        received_at:     msg.messageTimestamp
                           ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
                           : new Date().toISOString(),
        body_text:       text,
        attachments:     null,                            // TODO: tangkap media jika ada
        raw_payload:     {
          group_name:      getGroupSubject(remoteJid),
          wa_message_id:   msg.key.id,
          participant_id:  participantId,
          push_name:       senderName,
        },
        idempotency_key: msg.key.id,                      // ← WA message ID, unik per pesan
      }).catch(err => {
        console.warn('⚠️ Gagal simpan raw message, proses tetap lanjut:', err.message);
        return null;
      });


      // ── STEP 2: Proses raw message (deteksi threading + tiket) ──────────
      // Seluruh logika (small talk, AI relevance, duplikat, tiket baru) ada
      // di processRawMessage.js — whatsappService cukup simpan raw lalu lempar ke sana.
      if (raw?.id) {
        await processRawMessage(raw);
      } else {
        // raw save gagal → buat objek manual agar tetap bisa diproses
        await processRawMessage({
          id:              null,
          source_channel:  isGrp ? 'wa_group' : 'wa_dm',
          source_ref:      remoteJid,
          sender:          participantId ? `${senderName} (${participantId})` : senderName,
          body_text:       text,
          raw_payload:     {
            group_name:      getGroupSubject(remoteJid),
            wa_message_id:   msg.key.id,
          },
          idempotency_key: msg.key.id,
        });
      }

    } catch (err) {
      console.error("❌ Error processing WhatsApp:", err.message);
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