// src/infrastructure/telegram/telegramService.js

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import {
  saveEmailLog,
  updateIncidentStatus,
  getTicketsByStatus,
  getTicketsByDateRange,
  getDailySummary,
  getTicketById,
  findActiveTicketForThreading,
  findActiveTicketsForGroup,
  appendMessageToTicket,
  createConversationSession,
  updateConversationLastMessage
} from '../../database/supabase.js';
import { chatWithAI, checkMessageRelevance, routeMessageToActiveTickets } from '../ai/openaiService.js';

let bot = null;

// ================== INIT TELEGRAM BOT ==================
function initTelegramBot() {
  if (bot) return bot;

  if (!env.TG_TOKEN || !env.TG_CHAT_ID) {
    console.error("❌ TG_TOKEN atau TG_CHAT_ID belum diisi di .env");
    process.exit(1);
  }

  const MAIN_CHAT_ID = env.TG_CHAT_ID.trim();

  let ALLOWED_TELEGRAM_GROUPS = [];
  if (env.ALLOWED_TELEGRAM_GROUPS && env.ALLOWED_TELEGRAM_GROUPS.trim() !== '') {
    ALLOWED_TELEGRAM_GROUPS = env.ALLOWED_TELEGRAM_GROUPS
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
  }

  bot = new TelegramBot(env.TG_TOKEN, {
    polling: {
      interval: 300,
      params: { allowed_updates: ["message", "callback_query"] }
    }
  });

  // Tangkap error polling (glitch koneksi) agar tidak mencetak error fatal di konsol secara kasar
  bot.on('polling_error', (error) => {
    if (error.code === 'ECONNRESET' || error.message?.includes('ECONNRESET')) {
      console.warn("⚠️ [Telegram Bot] Koneksi internet sempat terputus (ECONNRESET). Bot mencoba terhubung kembali...");
    } else {
      console.warn("⚠️ [Telegram Bot Polling Alert]:", error.message);
    }
  });

  console.log(`🤖 Telegram Bot started successfully`);
  console.log(`   Main Chat ID     : ${MAIN_CHAT_ID}`);
  console.log(`   Monitored Groups : ${ALLOWED_TELEGRAM_GROUPS.length || 'Tidak ada'}`);

  // Command Handler
  bot.onText(/\/menu|\/start/i, async (msg) => await sendMainMenu(msg));
  bot.onText(/\/getgroupid/i, async (msg) => await sendGroupInfo(msg));

  // Message Handler
  bot.on('message', async (msg) => {
    if (!msg.text || msg.from?.is_bot) return;

    const chatId = msg.chat.id.toString();
    const groupName = msg.chat.title || "Private Chat";
    const sender = msg.from?.first_name || msg.from?.username || "Unknown";

    const isMonitoredGroup = ALLOWED_TELEGRAM_GROUPS.includes(chatId);
    const isMainGroup = chatId === MAIN_CHAT_ID;

    // Prioritas 1: Jika grup adalah monitored intake group → simpan ke Supabase
    if (isMonitoredGroup) {
      if (msg.text.startsWith('/')) return; // skip commands

      console.log(`\n📩 Telegram Message Received`);
      console.log(`Group  : ${groupName} (${chatId})`);
      console.log(`From   : ${sender}`);
      console.log(`Text   : ${msg.text.substring(0, 100)}${msg.text.length > 100 ? '...' : ''}`);

      const quotedMessageId = msg.reply_to_message ? msg.reply_to_message.message_id.toString() : null;
      const groupSubject = `Laporan dari ${groupName}`;

      let parentTicket = null;

      // 1. Jika me-reply pesan lama secara langsung (quote)
      if (quotedMessageId) {
        parentTicket = await findActiveTicketForThreading(chatId, groupSubject, quotedMessageId, 'telegram_group');
      } else {
        // 2. Jika pesan biasa, ambil semua tiket yang sedang aktif di grup ini
        const activeTickets = await findActiveTicketsForGroup(chatId, 'telegram_group');

        if (activeTickets.length === 1) {
          // Jika hanya ada 1 tiket aktif, lakukan pencocokan relevansi standar
          const isShort = msg.text.length < 20;
          const replyKeywords = ["baik", "oke", "ok", "siap", "tenggat", "kapan", "aman", "done", "proses", "sudah", "terima kasih", "thanks", "tolong", "perbaiki", "yah", "ini"];
          const hasReplyKeyword = replyKeywords.some(k => msg.text.toLowerCase().trim() === k);

          if (isShort && hasReplyKeyword) {
            parentTicket = activeTickets[0];
          } else {
            const isRelated = await checkMessageRelevance(msg.text, activeTickets[0].body, activeTickets[0].summary);
            if (isRelated) {
              parentTicket = activeTickets[0];
            }
          }
        } else if (activeTickets.length > 1) {
          // Jika ada beberapa tiket aktif sekaligus, gunakan AI routing
          const isShort = msg.text.length < 20;
          const replyKeywords = ["baik", "oke", "ok", "siap", "tenggat", "kapan", "aman", "done", "proses", "sudah", "terima kasih", "thanks", "tolong", "perbaiki", "yah", "ini"];
          const hasReplyKeyword = replyKeywords.some(k => msg.text.toLowerCase().trim() === k);

          if (isShort && hasReplyKeyword) {
            // Sebagai heuristik, hubungkan ke tiket aktif paling terakhir diperbarui
            parentTicket = activeTickets[0];
          } else {
            const matchedTicketId = await routeMessageToActiveTickets(msg.text, activeTickets);
            if (matchedTicketId) {
              parentTicket = activeTickets.find(t => t.ticket_id === matchedTicketId) || null;
            }
          }
        }
      }

      if (parentTicket) {
        console.log(`💬 Threading Telegram: Menambahkan balasan dari ${sender} ke tiket aktif ${parentTicket.ticket_id}`);
        
        // 1. Simpan/append ke body di database
        await appendMessageToTicket(parentTicket.ticket_id, parentTicket.body, sender, msg.text);

        // Update data sesi conversation agar menunjuk ke tiket ini
        await createConversationSession('telegram_group', chatId, parentTicket.ticket_id, msg.text, parentTicket.summary);

        // 2. Teruskan balasan ke Telegram utama (reply ke alert sebelumnya)
        if (parentTicket.telegram_chat_id && parentTicket.telegram_message_id) {
          try {
            const replyText = `💬 <b>Balasan dari ${sender} (Telegram Group - Ticket ${parentTicket.ticket_id})</b>:\n\n${msg.text}`;
            await bot.sendMessage(parentTicket.telegram_chat_id, replyText, {
              parse_mode: "HTML",
              reply_to_message_id: parseInt(parentTicket.telegram_message_id, 10)
            });
            console.log(`✅ Balasan berhasil diteruskan ke Telegram Utama (reply_to_message_id: ${parentTicket.telegram_message_id})`);
          } catch (tgErr) {
            console.error("⚠️ Gagal meneruskan balasan ke Telegram Utama:", tgErr.message);
          }
        }
        return; // Hentikan alur, jangan buat tiket baru!
      }

      // === BUKAN FOLLOW-UP: BUAT TIKET BARU ===
      const pseudoEmail = {
        id: `TG-${Date.now()}`,
        messageId: msg.message_id.toString(), // Actual Telegram message ID
        from: `${sender}`,
        subject: groupSubject,
        body: msg.text,
        source: "telegram_group",
        group_name: groupName
      };

      await sendIncidentAlert(pseudoEmail);

      // Buat sesi conversation baru di database
      await createConversationSession('telegram_group', chatId, pseudoEmail.id, msg.text, null);
      return;
    }

    // Prioritas 2: Jika main group (dan bukan monitored) → balas dengan AI
    if (isMainGroup) {
      if (msg.text.startsWith('/')) return; // skip commands

      const aiReply = await chatWithAI(msg.text);
      await bot.sendMessage(chatId, aiReply, { parse_mode: "Markdown" });
      return;
    }
  });

  // Callback Query Handler
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);

    const data = query.data;

    try {
      if (data.startsWith('status_')) {
        const newStatus = data.replace('status_', '');
        await handleStatusChange(query, chatId, newStatus);
      }

      if (data === 'main_menu') await sendMainMenu({ chat: { id: chatId } });
      if (data === 'tickets_all') await showTickets(chatId, null, "📋 Semua Tiket");
      if (data === 'tickets_inprogress') await showTickets(chatId, "In Progress", "🔄 Tiket In Progress");
      if (data === 'tickets_done') await showTickets(chatId, "Done", "✅ Tiket Selesai");
      if (data === 'today') await showTicketsByDays(chatId, 1, "📅 Tiket Hari Ini");
      if (data === 'last7') await showTicketsByDays(chatId, 7, "📅 Tiket 7 Hari Terakhir");
      if (data === 'last30') await showTicketsByDays(chatId, 30, "📅 Tiket 30 Hari Terakhir");
      if (data === 'summary') await sendDailySummary(chatId);

    } catch (err) {
      console.error("❌ Callback error:", err.message);
      await bot.sendMessage(chatId, "Terjadi kesalahan saat memproses permintaan.");
    }
  });

  return bot;
}

// ================== HELPER FORMAT TIKET ==================
function formatTicketList(tickets, title) {
  if (!tickets || tickets.length === 0) {
    return `${title}\n\nTidak ada tiket ditemukan.`;
  }

  let text = `${title} (${tickets.length} tiket)\n\n`;

  tickets.slice(0, 15).forEach((ticket, index) => {   // Limit 15 tiket
    const date = new Date(ticket.processed_at).toLocaleDateString('id-ID', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    const priorityEmoji = ticket.priority === 'CRITICAL' ? '🔴' :
      ticket.priority === 'HIGH' ? '🟠' : '🟡';

    text += `${index + 1}. ${priorityEmoji} *${ticket.ticket_id}*\n`;
    text += `   👤 ${ticket.from}\n`;
    text += `   📌 ${ticket.status || 'In Progress'}\n`;
    text += `   ⏰ ${date}\n`;
    text += `   💬 ${ticket.body ? ticket.body.substring(0, 80) + '...' : '-'}\n\n`;
  });

  if (tickets.length > 15) {
    text += `... dan ${tickets.length - 15} tiket lainnya.`;
  }

  return text;
}

// ================== SHOW TIKET ==================
async function showTickets(chatId, status, title) {
  const tickets = await getTicketsByStatus(status);
  const message = formatTicketList(tickets, title);
  await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

async function showTicketsByDays(chatId, days, title) {
  const tickets = await getTicketsByDateRange(days);
  const message = formatTicketList(tickets, title);
  await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

// ================== DAILY SUMMARY ==================
async function sendDailySummary(chatId) {
  const summary = await getDailySummary();

  const text = `📊 *Daily Summary*\n\n` +
    `Tanggal       : ${summary.date || new Date().toLocaleDateString('id-ID')}\n` +
    `Total Tiket   : *${summary.total || 0}*\n` +
    `Critical      : *${summary.critical || 0}* 🔴\n` +
    `High          : *${summary.high || 0}* 🟠\n` +
    `In Progress   : *${summary.inProgress || 0}* 🔄\n` +
    `Done          : *${summary.done || 0}* ✅`;

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
}

// ================== ESCAPE HTML ==================
// Escapes HTML special characters so user content renders safely in HTML parse mode
function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ================== CREATE FORMAL TICKET ==================
function createFormalTicket(email, analysis = {}) {
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

  return `📨 <b>PESAN BARU DITERIMA</b>

Ticket ID     : ${escapeHTML(email.id)}
Tanggal       : ${escapeHTML(tanggal)}
Waktu         : ${escapeHTML(waktu)} WIB

From          : ${escapeHTML(email.from)}
Group         : ${escapeHTML(email.group_name || email.subject || '-')}

Isi Pesan:
${escapeHTML(email.body)}

────────────────────────────────────`;
}

// ================== SEND INCIDENT ALERT ==================
async function sendIncidentAlert(email, analysis = {}) {
  const botInstance = initTelegramBot();
  const CHAT_ID = env.TG_CHAT_ID.trim();

  let messageText = email.formalMessage || createFormalTicket(email, analysis);

  const priority = (analysis.priority || "MEDIUM").toUpperCase();

  let telegramMessageId = null;
  let telegramChatId = null;

  try {
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Resolved", callback_data: "status_Done" },
            { text: "🔄 Escalated", callback_data: "status_Escalated" }
          ],
          [
            { text: "❌ Cancel", callback_data: "status_Cancelled" },
            { text: "➖ No Action", callback_data: "status_NoAction" }
          ]
        ]
      }
    };

    const sent = await botInstance.sendMessage(CHAT_ID, messageText, {
      parse_mode: "HTML",
      ...keyboard,
      disable_notification: !["HIGH", "CRITICAL"].includes(priority)
    });

    telegramMessageId = sent.message_id.toString();
    telegramChatId = sent.chat.id.toString();
    console.log(`✅ Alert terkirim ke Telegram (message_id: ${telegramMessageId})`);
  } catch (err) {
    console.error("⚠️ Gagal mengirim notifikasi alert ke Telegram:", err.message);
  }

  // Tetap simpan ke Supabase meskipun Telegram gagal
  await saveEmailLog(
    email,
    analysis,
    telegramMessageId ? true : false,
    telegramMessageId,
    telegramChatId
  );

  return { telegramMessageId, telegramChatId };
}

// ================== HANDLE STATUS CHANGE ==================
async function handleStatusChange(query, chatId, newStatus) {
  const messageId = query.message.message_id;
  let messageText = query.message.text || "";

  const statusMap = {
    Done: "✅ Resolved (Done)",
    Escalated: "🔄 Escalated",
    Cancelled: "❌ Cancelled",
    NoAction: "➖ No Action Needed"
  };

  const statusDisplay = statusMap[newStatus] || newStatus;

  // Update teks pesan
  messageText = messageText.replace(/Status\s*:\s*.*/i, `Status        : ${statusDisplay}`);

  await bot.editMessageText(messageText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [] }
  });

  await updateIncidentStatus(messageId.toString(), newStatus);

  await bot.answerCallbackQuery(query.id, {
    text: `✅ Status diubah menjadi: ${statusDisplay}`,
    show_alert: true
  });
}

// ================== MENU & INFO ==================
async function sendGroupInfo(msg) {
  const text = `📌 *Group Information*\n\n` +
    `Group ID   : \`${msg.chat.id}\`\n` +
    `Nama Grup  : ${msg.chat.title || "Private Chat"}\n` +
    `Tipe       : ${msg.chat.type}`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
}

async function sendMainMenu(msg) {
  const text = `🛠️ *Unified Incident Management Bot*\n\nSilakan pilih menu:`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Semua Tiket", callback_data: "tickets_all" }],
        [
          { text: "🔄 In Progress", callback_data: "tickets_inprogress" },
          { text: "✅ Done", callback_data: "tickets_done" }
        ],
        [
          { text: "📅 Hari Ini", callback_data: "today" },
          { text: "7 Hari", callback_data: "last7" },
          { text: "30 Hari", callback_data: "last30" }
        ],
        [{ text: "📊 Daily Summary", callback_data: "summary" }]
      ]
    }
  };

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown", ...keyboard });
}

// ================== EXPORTS ==================
export {
  initTelegramBot,
  sendIncidentAlert
};