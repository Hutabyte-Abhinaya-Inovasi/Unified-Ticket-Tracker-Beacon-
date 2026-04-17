// src/infrastructure/telegram/telegramService.js

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import { 
  saveEmailLog,
  updateIncidentStatus, 
  getTicketsByStatus, 
  getTicketsByDateRange, 
  searchTickets, 
  getDailySummary 
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

  // Parsing ALLOWED_TELEGRAM_GROUPS dengan aman
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

  console.log(`🤖 Telegram Bot started successfully!`);
  console.log(`   Main Incident Group : ${MAIN_CHAT_ID}`);
  console.log(`   Monitored Groups    : ${ALLOWED_TELEGRAM_GROUPS.length > 0 ? ALLOWED_TELEGRAM_GROUPS.join(', ') : 'TIDAK ADA'}`);
  console.log(`   Raw .env value      : "${env.ALLOWED_TELEGRAM_GROUPS || ''}"`);

  // ================== COMMAND HANDLER ==================
  bot.onText(/\/menu|\/start/i, async (msg) => await sendMainMenu(msg));

  bot.onText(/\/getgroupid/i, async (msg) => {
    const text = `📌 *Group Information*\n\n` +
                 `🔹 Group ID : \`${msg.chat.id}\`\n` +
                 `🔹 Nama Grup: ${msg.chat.title || "Private Chat"}\n` +
                 `🔹 Tipe     : ${msg.chat.type}`;
    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  });

  // ================== MESSAGE HANDLER ==================
  bot.on('message', async (msg) => {
    if (!msg.text || msg.from?.is_bot) return;

    const chatId = msg.chat.id.toString();
    const groupName = msg.chat.title || "Unknown Group";
    const sender = msg.from?.first_name || msg.from?.username || "Unknown";

    console.log(`\n📨 PESAN MASUK dari: ${groupName} (${chatId}) | Isi: ${msg.text}`);

    const isMainGroup = chatId === MAIN_CHAT_ID;
    const isMonitoredGroup = ALLOWED_TELEGRAM_GROUPS.includes(chatId);

    console.log(`   → Main Group?     : ${isMainGroup}`);
    console.log(`   → Monitored Group?: ${isMonitoredGroup} (dicek terhadap: ${ALLOWED_TELEGRAM_GROUPS})`);

    // Pesan dari Grup Utama
    if (isMainGroup) {
      if (msg.text.startsWith('/')) return;
      console.log(`   → Diproses sebagai AI Chat di grup utama`);
      const recentTickets = await getTicketsByDateRange(7);
      const context = `\n\nData tiket terbaru:\n${JSON.stringify(recentTickets.slice(0, 10), null, 2)}`;
      const aiReply = await chatWithAI(msg.text, context);
      await bot.sendMessage(chatId, aiReply, { parse_mode: "Markdown" });
      return;
    }

    // Pesan dari Grup Sumber (INI YANG KITA INGINKAN)
    if (isMonitoredGroup) {
      console.log(`   → ✅ DITERIMA SEBAGAI INCIDENT! Akan diteruskan ke grup utama`);

      const pseudoEmail = {
        id: `tg-${Date.now()}`,
        from: `${sender} (${groupName})`,
        subject: `Pesan dari ${groupName}`,
        body: msg.text,
        source: "telegram_group"
      };

      await sendIncidentAlert(pseudoEmail, {
        summary: msg.text.length > 200 ? msg.text.substring(0, 197) + "..." : msg.text,
        category: "Incident Management",
        priority: "MEDIUM"
      });

      return;
    }

    console.log(`   → Diabaikan (bukan grup sumber maupun utama)`);
  });

  // ================== CALLBACK QUERY ==================
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);
    const data = query.data;

    try {
      if (data.startsWith('done_')) {
        await handleMarkAsDone(query, chatId);
        return;
      }

      if (data === 'main_menu') return sendMainMenu({ chat: { id: chatId } });
      if (data === 'tickets_all') await showTickets(chatId, null, "Semua Tiket");
      if (data === 'tickets_inprogress') await showTickets(chatId, "In Progress", "Tiket In Progress");
      if (data === 'tickets_done') await showTickets(chatId, "Done", "Tiket Done");
      if (data === 'today') await showTicketsByDays(chatId, 1, "Tiket Hari Ini");
      if (data === 'last7') await showTicketsByDays(chatId, 7, "Tiket 7 Hari Terakhir");
      if (data === 'last30') await showTicketsByDays(chatId, 30, "Tiket 30 Hari Terakhir");
      if (data === 'summary') await sendDailySummary(chatId);
      if (data === 'search') {
        await bot.sendMessage(chatId, "🔍 Ketik kata kunci pencarian:");
      }
    } catch (err) {
      console.error("Callback error:", err.message);
    }
  });

  // ================== HELPER FUNCTIONS (tidak diubah) ==================
  async function sendMainMenu(msg) {
    const chatId = msg.chat.id;
    const text = `🚀 *Unified Incident Bot*\n\nPilih menu:`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📋 Semua Tiket", callback_data: "tickets_all" }],
          [
            { text: "🔴 In Progress", callback_data: "tickets_inprogress" },
            { text: "✅ Done", callback_data: "tickets_done" }
          ],
          [
            { text: "📅 Hari Ini", callback_data: "today" },
            { text: "📅 7 Hari", callback_data: "last7" },
            { text: "📅 30 Hari", callback_data: "last30" }
          ],
          [
            { text: "📊 Daily Summary", callback_data: "summary" },
            { text: "🔍 Search Tiket", callback_data: "search" }
          ],
          [{ text: "🔄 Refresh Menu", callback_data: "main_menu" }]
        ]
      }
    };

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...keyboard });
  }

  async function showTickets(chatId, status, title) {
    const tickets = status ? await getTicketsByStatus(status) : await getTicketsByStatus(null);
    await showTicketsList(chatId, tickets, title);
  }

  async function showTicketsByDays(chatId, days, title) {
    const tickets = await getTicketsByDateRange(days);
    await showTicketsList(chatId, tickets, title);
  }

  async function showTicketsList(chatId, tickets, title) {
    if (tickets.length === 0) {
      return bot.sendMessage(chatId, `📭 ${title}: Tidak ada tiket.`);
    }

    let message = `📋 *${title}* (${tickets.length} tiket)\n\n`;
    
    tickets.slice(0, 12).forEach((t) => {
      message += `🔖 *Ticket ID*: \`${t.ticket_id || 'N/A'}\`\n`;
      message += `**${t.priority || 'LOW'}** — ${t.category || '-'}\n`;
      message += `${t.subject || '(No Subject)'}\n`;
      message += `Dari: ${t.from}\n`;
      message += `Status: ${t.status}\n`;
      message += `${new Date(t.processed_at).toLocaleString('id-ID')}\n\n`;
    });

    if (message.length > 4000) message = message.slice(0, 3950) + "...";

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  }

  async function sendDailySummary(chatId) {
    const summary = await getDailySummary();
    const text = `📊 *Daily Summary*\n\n` +
      `📅 Tanggal     : ${summary.date}\n` +
      `Total Tiket     : ${summary.total}\n` +
      `Critical        : ${summary.critical} 🚨\n` +
      `High Priority   : ${summary.high} ⚠️\n` +
      `In Progress     : ${summary.inProgress}\n` +
      `Done            : ${summary.done} ✅`;

    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  async function handleMarkAsDone(query, chatId) {
    try {
      const telegramMessageId = query.message.message_id.toString();
      let newText = query.message.text || "";

      newText = newText.replace(/Status: \*\*In Progress\*\* ✅/i, "Status: **✅ DONE** (Resolved)");
      newText = newText.replace(/Status: In Progress ✅/i, "Status: **✅ DONE** (Resolved)");

      await bot.editMessageText(newText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [] }
      });

      await updateIncidentStatus(telegramMessageId, "Done");

      await bot.answerCallbackQuery(query.id, { 
        text: "✅ Incident telah ditandai selesai", 
        show_alert: true 
      });
    } catch (err) {
      console.error("Mark as Done error:", err.message);
    }
  }

  return bot;
}

// ================== SEND INCIDENT ALERT ==================
export async function sendIncidentAlert(email, analysis = {}) {
  const botInstance = initTelegramBot();
  const CHAT_ID = env.TG_CHAT_ID.trim();

  const defaultAnalysis = {
    summary: email.body.substring(0, 150),
    category: "Incident Management",
    priority: "MEDIUM"
  };

  const finalAnalysis = { ...defaultAnalysis, ...analysis };

  const initialText = `🚨 INCIDENT ALERT 🚨

🔖 *Ticket ID*: \`Menunggu...\`

*From*: ${email.from}
*Subject*: ${email.subject}

Summary:
${finalAnalysis.summary}

Category: ${finalAnalysis.category}
*Priority*: ${finalAnalysis.priority}
Status: **In Progress** ✅`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Mark as Done", callback_data: `done_${Date.now()}` }]]
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

    const finalText = `🚨 INCIDENT ALERT 🚨

🔖 *Ticket ID*: \`${ticketId}\`

*From*: ${email.from}
*Subject*: ${email.subject}

Summary:
${finalAnalysis.summary}

Category: ${finalAnalysis.category}
*Priority*: ${finalAnalysis.priority}
Status: **In Progress** ✅`;

    await botInstance.editMessageText(finalText, {
      chat_id: CHAT_ID,
      message_id: sent.message_id,
      parse_mode: "Markdown",
      reply_markup: keyboard.reply_markup
    });

    console.log(`✅ Ticket dibuat: ${ticketId}`);
  } catch (err) {
    console.error("❌ Gagal update Ticket ID:", err.message);
  }
}