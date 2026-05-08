// src/infrastructure/whatsapp/whatsappService.js
import P from "pino";
import baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { analyzeEmail } from "../ai/openaiService.js";
import { sendIncidentAlert } from "../telegram/telegramService.js";
import { saveEmailLog, generateTicketId } from "../../database/supabase.js";

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = baileys;

const AUTH_FOLDER = "./auth_info";

const groupCache = new Map();

const ALLOWED_GROUPS = new Set([
  "120363021244940257@g.us",
  "628111188176-1519023923@g.us",
  "628118821733-1553603674@g.us",
  "628118501322-1540806627@g.us",
  "628118820105-1549007507@g.us",
]);

console.log(`📋 ALLOWED_GROUPS loaded: ${ALLOWED_GROUPS.size} group(s)`);

let sock = null;

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

function normalizePriority(priority = "") {
  return String(priority).trim().toUpperCase();
}

function isLowPriority(priority = "") {
  return normalizePriority(priority) === "LOW";
}

function getGroupSubject(remoteJid) {
  const metadata = groupCache.get(remoteJid);
  return metadata?.subject?.trim() || "Unknown WhatsApp Group";
}

/**
 * Membuat format pesan Ticket yang formal dan rapi
 */
function createFormalTicket(pseudoEmail, analysis) {
  const now = new Date();
  const tanggal = now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const waktu = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  const priority = analysis?.priority?.toUpperCase() || "MEDIUM";

  return `PESAN BARU DARI WHATSAPP

Ticket ID     : ${pseudoEmail.id}
Tanggal       : ${tanggal}
Waktu         : ${waktu} WIB

From          : ${pseudoEmail.from}
Group         : ${pseudoEmail.group_name}

Isi Pesan:
${pseudoEmail.body}

────────────────────────────────────`;
}

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
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

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

  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id && update.subject !== undefined) {
        const current = groupCache.get(update.id) || {};
        groupCache.set(update.id, { ...current, ...update });
        console.log(`🔄 Group subject updated: ${update.subject} (${update.id})`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") return;
      if (!messages?.length) return;

      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid || "";
      if (!isGroup(remoteJid) || !ALLOWED_GROUPS.has(remoteJid)) return;

      const senderName = msg.pushName || "Unknown User";
      const text = extractMessageText(msg);

      if (!text) return;

      console.log("\n📩 WhatsApp Message Received");
      console.log(`Group : ${getGroupSubject(remoteJid)}`);
      console.log(`From  : ${senderName}`);
      console.log(`Text  : ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);

      // === GUNAKAN TICKET ID RESMI ===
      const ticketId = await generateTicketId();

      const pseudoEmail = {
        id: ticketId,
        from: senderName,
        subject: getGroupSubject(remoteJid),
        body: text,
        source: "whatsapp",
        group_id: remoteJid,
        group_name: getGroupSubject(remoteJid),
        timestamp: new Date().toISOString()
      };

      const analysis = await analyzeEmail(pseudoEmail);

      if (isLowPriority(analysis?.priority)) {
        console.log("🟢 Priority LOW detected -> skipped");
        return;
      }

      // Buat pesan formal
      const formalMessage = createFormalTicket(pseudoEmail, analysis);

      // Kirim ke Telegram
      const tg = await sendIncidentAlert({
        ...pseudoEmail,
        formalMessage,
        analysis
      });

      // Simpan ke database
      await saveEmailLog(
        pseudoEmail,
        analysis,
        true,
        tg?.telegramMessageId || null,
        tg?.telegramChatId || null
      );

      console.log(`✅ Ticket ${ticketId} forwarded to Telegram`);

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