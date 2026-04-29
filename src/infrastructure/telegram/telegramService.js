// src/infrastructure/telegram/telegramService.js

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import { 
  saveEmailLog,
  updateIncidentStatus, 
  getTicketsByStatus, 
  getTicketsByDateRange, 
  getDailySummary,
  getTicketById          // ← Ditambahkan
} from '../../database/supabase.js';
import { chatWithAI } from '../ai/openaiService.js';

let bot = null;

export function initTelegramBot() {
  if (bot) return bot;

  if (!env.TG_TOKEN || !env.TG_CHAT_ID) {
    console.error("❌ TG_TOKEN atau TG_CHAT_ID belum diisi di .env");
    process.exit(1);
  }

  const MAIN_CHAT_ID = env.TG_CHAT_ID.trim();

  // Parsing ALLOWED_TELEGRAM_GROUPS
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

  console.log(`🤖 Telegram Bot started successfully`);
  console.log(`   Main Chat ID     : ${MAIN_CHAT_ID}`);
  console.log(`   Monitored Groups : ${ALLOWED_TELEGRAM_GROUPS.length || 'Tidak ada'}`);

  // ================== COMMAND HANDLER ==================
  bot.onText(/\/menu|\/start/i, async (msg) => await sendMainMenu(msg));
  bot.onText(/\/getgroupid/i, async (msg) => await sendGroupInfo(msg));

  // ================== MESSAGE HANDLER ==================
  bot.on('message', async (msg) => {
    if (!msg.text || msg.from?.is_bot) return;

    const chatId = msg.chat.id.toString();
    const groupName = msg.chat.title || "Private Chat";
    const sender = msg.from?.first_name || msg.from?.username || "Unknown";

    const isMainGroup = chatId === MAIN_CHAT_ID;
    const isMonitoredGroup = ALLOWED_TELEGRAM_GROUPS.includes(chatId);

    // ================== MAIN GROUP (AI ITSM Assistant) ==================
    if (isMainGroup) {
      console.log(`🤖 AI Processing command from main group: ${msg.text}`);

      // Jika command biasa (/menu, dll) → skip AI
      if (msg.text.startsWith('/')) {
        return;
      }

      // Kirim ke AI dengan tool calling capability
      const aiReply = await chatWithAI(msg.text);

      await bot.sendMessage(chatId, aiReply, { 
        parse_mode: "Markdown" 
      });
      return;
    }

    // ================== MONITORED GROUP (Incident dari WhatsApp) ==================
    if (isMonitoredGroup) {
      console.log(`📨 Incident diterima dari grup: ${groupName}`);

      const pseudoEmail = {
        id: `tg-${Date.now()}`,
        from: `${sender} (${groupName})`,
        subject: `Laporan dari ${groupName}`,
        body: msg.text,
        source: "telegram_group"
      };

      await sendIncidentAlert(pseudoEmail);
      return;
    }

    console.log(`→ Pesan diabaikan (bukan main group atau monitored group)`);
  });

  // ================== CALLBACK QUERY (Tombol Status) ==================
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);

    const data = query.data;

    try {
      if (data.startsWith('status_')) {
        const newStatus = data.replace('status_', '');
        await handleStatusChange(query, chatId, newStatus);
        return;
      }

      // Menu Navigation
      if (data === 'main_menu') await sendMainMenu({ chat: { id: chatId } });
      if (data === 'tickets_all') await showTickets(chatId, null, "Semua Tiket");
      if (data === 'tickets_inprogress') await showTickets(chatId, "In Progress", "Tiket In Progress");
      if (data === 'tickets_done') await showTickets(chatId, "Done", "Tiket Selesai");
      if (data === 'today') await showTicketsByDays(chatId, 1, "Tiket Hari Ini");
      if (data === 'last7') await showTicketsByDays(chatId, 7, "Tiket 7 Hari Terakhir");
      if (data === 'last30') await showTicketsByDays(chatId, 30, "Tiket 30 Hari Terakhir");
      if (data === 'summary') await sendDailySummary(chatId);

    } catch (err) {
      console.error("Callback error:", err.message);
      await bot.sendMessage(chatId, "Terjadi kesalahan saat memproses permintaan.");
    }
  });

  return bot;
}

// ================== SEND INCIDENT ALERT (Formal) ==================
export async function sendIncidentAlert(email, analysis = {}) {
  const botInstance = initTelegramBot();
  const CHAT_ID = env.TG_CHAT_ID.trim();

  const finalAnalysis = {
    category: analysis.category || "Incident Management",
    priority: analysis.priority || "MEDIUM",
    summary: analysis.summary || (email.body.length > 180 
      ? email.body.substring(0, 180) + "..." 
      : email.body)
  };

  const initialText = `LAPORAN INCIDENT BARU

────────────────────────────────
Ticket ID     : Menunggu...

Pengirim      : ${email.from}
Subject       : ${email.subject}

Ringkasan:
${finalAnalysis.summary}

Kategori      : ${finalAnalysis.category}
Prioritas     : ${finalAnalysis.priority}
Status        : In Progress
────────────────────────────────`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Resolved", callback_data: "status_Done" },
          { text: "🔄 Escalated", callback_data: "status_Escalated" }
        ],
        [
          { text: "❌ Cancel", callback_data: "status_Cancelled" },
          { text: "➖ No Action Needed", callback_data: "status_NoAction" }
        ]
      ]
    }
  };

  const sent = await botInstance.sendMessage(CHAT_ID, initialText, {
    parse_mode: "Markdown",
    ...keyboard,
    disable_notification: finalAnalysis.priority !== "CRITICAL"
  });

  const telegramMessageId = sent.message_id.toString();

  try {
    const ticketId = await saveEmailLog(
      email,
      finalAnalysis,
      true,
      telegramMessageId,
      sent.chat.id.toString()
    );

    const finalText = `LAPORAN INCIDENT BARU

────────────────────────────────
Ticket ID     : ${ticketId}

Pengirim      : ${email.from}
Subject       : ${email.subject}

Ringkasan:
${finalAnalysis.summary}

Kategori      : ${finalAnalysis.category}
Prioritas     : ${finalAnalysis.priority}
Status        : In Progress
────────────────────────────────`;

    await botInstance.editMessageText(finalText, {
      chat_id: CHAT_ID,
      message_id: sent.message_id,
      parse_mode: "Markdown",
      reply_markup: keyboard.reply_markup
    });

    console.log(`✅ Ticket berhasil dibuat: ${ticketId}`);
  } catch (err) {
    console.error("❌ Gagal menyimpan ticket:", err.message);
  }
}

// ================== HANDLE STATUS CHANGE (Callback Button) ==================
async function handleStatusChange(query, chatId, newStatus) {
  const messageId = query.message.message_id;
  let messageText = query.message.text || "";

  let statusDisplay = "";
  switch (newStatus) {
    case "Done":      statusDisplay = "Resolved (Done)"; break;
    case "Escalated": statusDisplay = "Resolved (Escalated)"; break;
    case "Cancelled": statusDisplay = "Cancelled"; break;
    case "NoAction":  statusDisplay = "No Action Needed"; break;
    default:          statusDisplay = newStatus;
  }

  messageText = messageText.replace(
    /Status\s*:\s*In Progress/i,
    `Status        : ${statusDisplay}`
  );

  await bot.editMessageText(messageText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [] }
  });

  await updateIncidentStatus(messageId.toString(), newStatus);

  await bot.answerCallbackQuery(query.id, {
    text: `Status diubah menjadi: ${statusDisplay}`,
    show_alert: true
  });
}

// ================== HELPER FUNCTIONS ==================
async function sendGroupInfo(msg) {
  const text = `Group Information

Group ID   : ${msg.chat.id}
Nama Grup  : ${msg.chat.title || "Private Chat"}
Tipe       : ${msg.chat.type}`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
}

async function sendMainMenu(msg) {
  const text = `Unified Incident Management Bot

Silakan pilih menu:`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Semua Tiket", callback_data: "tickets_all" }],
        [
          { text: "In Progress", callback_data: "tickets_inprogress" },
          { text: "Done", callback_data: "tickets_done" }
        ],
        [
          { text: "Hari Ini", callback_data: "today" },
          { text: "7 Hari Terakhir", callback_data: "last7" },
          { text: "30 Hari", callback_data: "last30" }
        ],
        [
          { text: "Daily Summary", callback_data: "summary" },
          { text: "Cari Tiket", callback_data: "search" }
        ],
        [{ text: "Refresh Menu", callback_data: "main_menu" }]
      ]
    }
  };

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown", ...keyboard });
}

// Placeholder untuk fungsi lain (bisa kamu kembangkan nanti)
async function showTickets(chatId, status, title) {
  await bot.sendMessage(chatId, `📋 ${title}\n\nFitur ini sedang dikembangkan.`);
}

async function showTicketsByDays(chatId, days, title) {
  await bot.sendMessage(chatId, `📅 ${title}\n\nFitur ini sedang dikembangkan.`);
}

async function sendDailySummary(chatId) {
  const summary = await getDailySummary();
  const text = `📊 Daily Summary\n\n` +
    `Tanggal     : ${summary.date}\n` +
    `Total Tiket : ${summary.total}\n` +
    `Critical    : ${summary.critical}\n` +
    `High        : ${summary.high}\n` +
    `In Progress : ${summary.inProgress}\n` +
    `Done        : ${summary.done}`;

  await bot.sendMessage(chatId, text);
}

// Export
export { initTelegramBot, sendIncidentAlert };