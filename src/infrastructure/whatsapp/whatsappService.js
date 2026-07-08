// src/infrastructure/whatsapp/whatsappService.js
import P from "pino";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { useSupabaseAuthState } from "./supabaseAuthState.js";
import { analyzeEmail, checkMessageRelevance, routeMessageToActiveTickets, detectStatusChangeFromReply } from "../ai/openaiService.js";
import { sendIncidentAlert, initTelegramBot, updateIncidentStatusAndMessage } from "../telegram/telegramService.js";
import { saveEmailLog, generateTicketId, findActiveTicketForThreading, findActiveTicketsForGroup, appendMessageToTicket, createConversationSession, updateConversationLastMessage } from "../../database/supabase.js";

// Railway environment flag — di Railway tidak ada terminal interaktif untuk scan QR
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_SERVICE_ID;

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

/**
 * Kirim QR code ke Telegram sebagai GAMBAR PNG agar bisa di-scan langsung dari HP.
 * @param {string} qr - QR code string dari Baileys
 */
async function sendQRToTelegram(qr) {
  try {
    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const QRCode = (await import("qrcode")).default;
    const token = process.env.TG_TOKEN;
    const chatId = process.env.TG_CHAT_ID;
    if (!token || !chatId) return;

    const bot = new TelegramBot(token);

    // Generate QR sebagai Buffer PNG
    const qrBuffer = await QRCode.toBuffer(qr, {
      type: "png",
      width: 512,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    // Kirim sebagai foto agar bisa langsung di-scan dengan kamera HP
    await bot.sendPhoto(chatId, qrBuffer, {
      caption:
        "📱 *Scan QR ini dengan WhatsApp!*\n\n" +
        "1\\. Buka WhatsApp di HP\n" +
        "2\\. Klik ⋮ *Menu* → *Perangkat Tertaut*\n" +
        "3\\. Klik *Tautkan Perangkat*\n" +
        "4\\. Arahkan kamera ke foto ini\n\n" +
        "⚠️ QR kedaluwarsa dalam ~60 detik\\. Jika gagal, restart Railway service\\.",
      parse_mode: "MarkdownV2",
    });

    console.log("📤 QR code (gambar) berhasil dikirim ke Telegram!");
  } catch (err) {
    console.error("⚠️ Gagal kirim QR ke Telegram:", err.message);
  }
}

export async function connectWhatsApp() {
  if (sock) return sock;

  console.log("🔑 Memuat WhatsApp auth dari Supabase...");
  const { state, saveCreds } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();

  console.log("📱 Starting WhatsApp connection...");

  sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: !IS_RAILWAY,  // Di Railway, jangan print QR ke terminal
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

      if (IS_RAILWAY) {
        // Di Railway: kirim QR ke Telegram karena tidak ada terminal interaktif
        console.log("🚂 Terdeteksi Railway environment — mengirim QR ke Telegram...");
        await sendQRToTelegram(qr);
      } else {
        // Di lokal: tampilkan QR di terminal seperti biasa
        qrcode.generate(qr, { small: true });
      }
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

      const quotedStanzaId = msg.message.extendedTextMessage?.contextInfo?.stanzaId || null;
      const groupSubject = getGroupSubject(remoteJid);

      let parentTicket = null;

      // 1. Jika me-reply pesan lama secara langsung (quote)
      if (quotedStanzaId) {
        parentTicket = await findActiveTicketForThreading(remoteJid, groupSubject, quotedStanzaId, 'whatsapp');
      } else {
        // 2. Jika pesan biasa, ambil semua tiket yang sedang aktif di grup ini
        const activeTickets = await findActiveTicketsForGroup(remoteJid, 'whatsapp');
        
        if (activeTickets.length === 1) {
          // Jika hanya ada 1 tiket aktif, lakukan pencocokan relevansi standar
          const isShort = text.length < 20;
          const replyKeywords = ["baik", "oke", "ok", "siap", "tenggat", "kapan", "aman", "done", "proses", "sudah", "terima kasih", "thanks", "tolong", "perbaiki", "yah", "ini"];
          const hasReplyKeyword = replyKeywords.some(k => text.toLowerCase().trim() === k);

          if (isShort && hasReplyKeyword) {
            parentTicket = activeTickets[0];
          } else {
            const isRelated = await checkMessageRelevance(text, activeTickets[0].body, activeTickets[0].summary);
            if (isRelated) {
              parentTicket = activeTickets[0];
            }
          }
        } else if (activeTickets.length > 1) {
          // Jika ada beberapa tiket aktif sekaligus, gunakan AI routing
          const isShort = text.length < 20;
          const replyKeywords = ["baik", "oke", "ok", "siap", "tenggat", "kapan", "aman", "done", "proses", "sudah", "terima kasih", "thanks", "tolong", "perbaiki", "yah", "ini"];
          const hasReplyKeyword = replyKeywords.some(k => text.toLowerCase().trim() === k);

          if (isShort && hasReplyKeyword) {
            // Sebagai heuristik, hubungkan ke tiket aktif paling terakhir diperbarui
            parentTicket = activeTickets[0];
          } else {
            const matchedTicketId = await routeMessageToActiveTickets(text, activeTickets);
            if (matchedTicketId) {
              parentTicket = activeTickets.find(t => t.ticket_id === matchedTicketId) || null;
            }
          }
        }
      }

      if (parentTicket) {
        console.log(`💬 Threading: Menambahkan balasan dari ${senderName} ke tiket aktif ${parentTicket.ticket_id}`);
        
        // 1. Simpan/append ke body di database
        await appendMessageToTicket(parentTicket.ticket_id, parentTicket.body, senderName, text);

        // Update data sesi conversation agar menunjuk ke tiket ini
        await createConversationSession('whatsapp', remoteJid, parentTicket.ticket_id, text, parentTicket.summary);

        // 2. Teruskan balasan ke Telegram (reply ke alert sebelumnya)
        if (parentTicket.telegram_chat_id && parentTicket.telegram_message_id) {
          try {
            const targetChatId = parentTicket.telegram_chat_id.split('|')[0];
            const botInstance = initTelegramBot();
            const replyText = `💬 <b>Balasan dari ${senderName} (Ticket ${parentTicket.ticket_id})</b>:\n\n${text}`;
            await botInstance.sendMessage(targetChatId, replyText, {
              parse_mode: "HTML",
              reply_to_message_id: parseInt(parentTicket.telegram_message_id, 10)
            });
            console.log(`✅ Balasan berhasil diteruskan ke Telegram (reply_to_message_id: ${parentTicket.telegram_message_id})`);
          } catch (tgErr) {
            console.error("⚠️ Gagal meneruskan balasan ke Telegram:", tgErr.message);
          }
        }

        // 3. Cek apakah balasan ini menyatakan perubahan status (Done, Escalated, Cancelled)
        try {
          const detectedStatus = await detectStatusChangeFromReply(text);
          if (detectedStatus && detectedStatus !== 'no_change') {
            await updateIncidentStatusAndMessage(parentTicket.ticket_id, detectedStatus, true);
          }
        } catch (statusErr) {
          console.error("⚠️ Gagal memproses deteksi status otomatis dari balasan WhatsApp:", statusErr.message);
        }

        return; // Hentikan alur, jangan buat tiket baru!
      }

      // === BUKAN FOLLOW-UP: BUAT TIKET BARU ===
      const ticketId = await generateTicketId();

      const pseudoEmail = {
        id: ticketId,             // Digunakan sebagai fallback/ticket_id
        ticket_id: ticketId,      // Ticket ID resmi
        messageId: msg.key.id,    // WhatsApp message ID yang sebenarnya
        from: senderName,
        subject: groupSubject,
        body: text,
        source: "whatsapp",
        group_id: remoteJid,
        group_name: groupSubject,
        timestamp: new Date().toISOString()
      };

      const analysis = await analyzeEmail(pseudoEmail);

      if (isLowPriority(analysis?.priority)) {
        console.log("🟢 Priority LOW detected -> skipped");
        return;
      }

      // Buat pesan formal
      const formalMessage = createFormalTicket(pseudoEmail, analysis);

      // Kirim ke Telegram (ini sudah otomatis menyimpan ke database di dalamnya)
      const tg = await sendIncidentAlert({
        ...pseudoEmail,
        formalMessage,
        analysis
      });

      console.log(`✅ Ticket ${ticketId} successfully created and forwarded to Telegram (Msg ID: ${tg?.telegramMessageId || 'N/A'})`);

      // Buat sesi conversation baru di database
      await createConversationSession('whatsapp', remoteJid, ticketId, text, analysis?.summary || null);

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