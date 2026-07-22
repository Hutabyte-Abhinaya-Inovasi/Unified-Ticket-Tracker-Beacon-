// src/infrastructure/telegram/telegramService.js

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import {
  saveEmailLog,
  saveRawIntakeMessage,
  updateIncidentStatus,
  getTicketsByStatus,
  getTicketsByDateRange,
  getTicketsByDate,
  searchTickets,
  getDailySummary,
  getTicketById,
  updateTicket,
  generateTicketId,
  findActiveTicketForThreading,
  findActiveTicketsForGroup,
  appendMessageToTicket,
  createConversationSession,
  updateConversationLastMessage,
  closeConversationSessionByTicket
} from '../../database/supabase.js';
import { processRawMessage } from '../../usecases/processRawMessage.js';
import {
  chatWithAI,
  analyzeEmail,
  checkMessageRelevance,
  routeMessageToActiveTickets,
  detectStatusChangeFromReply,
  extractTicketFields
} from '../ai/openaiService.js';
import {
  createSession,
  createRepairSession,
  getSession,
  destroySession,
  updateSession,
  computePendingFields,
  isRequiredField,
  getFieldPrompt,
  formatSessionSummary,
  formatRepairSummary,
  formatDraftForUTT,
  validateField,
  ALL_FIELDS,
  REPAIR_FIELDS,
  FIELD_LABELS,
  DB_FIELD_LABELS,
  FIELD_QUESTIONS
} from './manualTicketSession.js';

let bot = null;

// ================== INIT TELEGRAM BOT ==================
function initTelegramBot() {
  if (bot) return bot;

  if (!env.TG_TOKEN || !env.TG_CHAT_ID) {
    console.error("❌ TG_TOKEN atau TG_CHAT_ID belum diisi di .env");
    process.exit(1);
  }

  const MAIN_CHAT_ID = env.TG_CHAT_ID.trim();
  // Grup Beacon Hutabyte: tujuan tiket final
  const BEACON_CHAT_ID = (env.TG_BEACON_CHAT_ID || '-5546265953').trim();
  // Grup UTT: tempat pre-konfirmasi draft dan repair tiket
  const UTT_CHAT_ID = (env.TG_UTT_CHAT_ID || '-1003753882093').trim();

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

  // Cegah spam log di terminal jika token tidak valid (401)
  bot.on("polling_error", (err) => {
    if (err.message.includes("401")) {
      console.error("❌ Telegram Bot Polling Error: 401 Unauthorized. Token bot di .env tidak valid atau expired. Polling dinonaktifkan.");
      bot.stopPolling();
    } else {
      console.warn("⚠️ Telegram Bot Polling Error:", err.message);
    }
  });

  console.log(`🤖 Telegram Bot started successfully`);
  console.log(`   Main Chat ID     : ${MAIN_CHAT_ID}`);
  console.log(`   Monitored Groups : ${ALLOWED_TELEGRAM_GROUPS.length || 'Tidak ada'}`);

  // ─────── COMMAND HANDLERS ───────
  bot.onText(/\/menu|\/start/i, async (msg) => await sendMainMenu(msg));
  bot.onText(/\/getgroupid/i, async (msg) => await sendGroupInfo(msg));

  // Command: /ai [pertanyaan] → interaksi dengan AI (RAG + Tools)
  bot.onText(/\/ai(?: (.+))?/s, async (msg, match) => {
    const chatId = msg.chat.id;
    const userInput = match[1];

    if (!userInput) {
      await bot.sendMessage(chatId, "Silakan berikan pertanyaan setelah command /ai.\n\nContoh:\n`/ai tampilkan detail tiket INC-20260709-0012`", { parse_mode: 'Markdown' });
      return;
    }

    // Tampilkan pesan "sedang berpikir"
    const thinkingMsg = await bot.sendMessage(chatId, "🤖 AI sedang berpikir...", { reply_to_message_id: msg.message_id });

    try {
      const aiReply = await chatWithAI(userInput);
      await bot.editMessageText(aiReply, { chat_id: chatId, message_id: thinkingMsg.message_id, parse_mode: "Markdown" });
    } catch (err) {
      console.error("❌ Gagal memproses command /ai:", err.message);
      await bot.editMessageText("Maaf, terjadi kesalahan saat memproses permintaan Anda.", { chat_id: chatId, message_id: thinkingMsg.message_id });
    }
  });
  // Command: /tiket atau /tiket baru → mulai manual input
  bot.onText(/\/tiket(\s+baru)?/i, async (msg) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from?.id?.toString() || 'unknown';
    const senderName = msg.from?.first_name || msg.from?.username || 'Unknown';

    // Cek apakah sudah ada sesi aktif
    const existingSession = getSession(chatId, userId);
    if (existingSession) {
      await bot.sendMessage(chatId,
        '⚠️ Kamu sudah memiliki sesi input tiket yang aktif.\n\n' +
        'Lanjutkan mengisi tiket atau ketik /cancel untuk membatalkan.',
        { reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Sesi', callback_data: 'manual_cancel' }]] } }
      );
      return;
    }

    // Buat sesi baru
    createSession(chatId, userId, senderName);

    await bot.sendMessage(chatId,
      `✏️ <b>Input Manual Tiket Baru</b>\n\n` +
      `Halo ${escapeHTML(senderName)}! Silakan ceritakan masalah atau permintaan yang ingin didaftarkan sebagai tiket.\n\n` +
      `<i>Cukup tulis bebas, AI akan mengekstrak detailnya secara otomatis.</i>\n\n` +
      `Contoh:\n` +
      `<i>"Server SIMRS di gedung A tidak bisa diakses sejak jam 9 pagi. Dilaporkan oleh Pak Budi via telepon."</i>\n\n` +
      `Ketik pesan sekarang 👇`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Batalkan', callback_data: 'manual_cancel' }]]
        }
      }
    );
  });

  // Command: /cancel → batalkan sesi aktif
  bot.onText(/\/cancel/i, async (msg) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from?.id?.toString() || 'unknown';
    const session = getSession(chatId, userId);
    if (session) {
      destroySession(chatId, userId);
      await bot.sendMessage(chatId, '❌ Sesi input tiket dibatalkan.');
    } else {
      await bot.sendMessage(chatId, 'ℹ️ Tidak ada sesi aktif untuk dibatalkan.');
    }
  });

  // Command: /get, /edit, /id <ticketId> eksplisit → Repair tiket langsung dari DB
  bot.onText(/\/(?:get|edit|id)\s+(TCK-[\w-]+)/i, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from?.id?.toString() || 'unknown';
    const senderName = msg.from?.first_name || msg.from?.username || 'Unknown';
    const ticketId = match[1].toUpperCase();

    // Cek sesi aktif
    const existingSession = getSession(chatId, userId);
    if (existingSession) {
      await bot.sendMessage(chatId,
        '⚠️ Kamu masih punya sesi aktif. Selesaikan atau ketik /cancel terlebih dahulu.',
        { reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Sesi', callback_data: 'manual_cancel' }]] } }
      );
      return;
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔍 Mengambil data tiket <code>${escapeHTML(ticketId)}</code>...`, { parse_mode: 'HTML' });

    try {
      const ticket = await getTicketById(ticketId);
      if (!ticket) {
        await bot.editMessageText(
          `❌ Tiket <code>${escapeHTML(ticketId)}</code> tidak ditemukan di database.`,
          { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
        );
        return;
      }

      // Buat sesi REPAIR dari data DB
      createRepairSession(chatId, userId, ticket, senderName);

      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

      // Tampilkan repair summary dengan tombol edit
      const session = getSession(chatId, userId);
      const { text, keyboard } = formatRepairSummary(session);
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });

    } catch (err) {
      console.error('❌ /get handler error:', err.message);
      await bot.editMessageText(
        '❌ Gagal mengambil data tiket. Coba lagi.',
        { chat_id: chatId, message_id: loadingMsg.message_id }
      ).catch(() => { });
    }
  });

  // Command: /edit <keyword bebas> → Cari & tampilkan list tiket untuk dipilih
  // Dipasang SETELAH handler TCK eksplisit supaya tidak clash
  bot.onText(/\/(?:get|edit|id)\s+(?!TCK-)(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from?.id?.toString() || 'unknown';
    const keyword = match[1].trim();

    // Cek sesi aktif
    const existingSession = getSession(chatId, userId);
    if (existingSession) {
      await bot.sendMessage(chatId,
        '⚠️ Kamu masih punya sesi aktif. Selesaikan atau ketik /cancel terlebih dahulu.',
        { reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Sesi', callback_data: 'manual_cancel' }]] } }
      );
      return;
    }

    const loadingMsg = await bot.sendMessage(chatId, `🔍 Mencari tiket: <i>${escapeHTML(keyword)}</i>...`, { parse_mode: 'HTML' });

    try {
      let tickets = [];
      let queryLabel = keyword;

      // Deteksi kata kunci waktu (WIB)
      const kwLower = keyword.toLowerCase().trim();
      const todayWib = new Date(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }));
      const todayStr = todayWib.toISOString().split('T')[0]; // YYYY-MM-DD

      const yesterdayWib = new Date(todayWib);
      yesterdayWib.setDate(yesterdayWib.getDate() - 1);
      const yesterdayStr = yesterdayWib.toISOString().split('T')[0];

      if (kwLower.includes('hari ini') || kwLower === 'today') {
        tickets = await getTicketsByDate(todayStr);
        queryLabel = `hari ini (${todayStr})`;
      } else if (kwLower.includes('kemarin') || kwLower === 'yesterday') {
        tickets = await getTicketsByDate(yesterdayStr);
        queryLabel = `kemarin (${yesterdayStr})`;
      } else {
        // Full-text search keyword
        tickets = await searchTickets(keyword);
        queryLabel = `"${keyword}"`;
      }

      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

      if (!tickets || tickets.length === 0) {
        await bot.sendMessage(chatId,
          `🔍 Tidak ada tiket ditemukan untuk: <i>${escapeHTML(queryLabel)}</i>\n\n` +
          `Coba kata kunci lain, atau gunakan:\n` +
          `• <code>/edit hari ini</code>\n• <code>/edit kemarin</code>\n• <code>/edit TCK-YYYYMMDD-XXXX</code>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Batasi 8 tiket untuk efisiensi tampilan
      const displayTickets = tickets.slice(0, 8);

      // Peta prioritas → emoji
      const priorityEmoji = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢' };
      const statusShort = {
        'In Progress': '⚙️',
        'Done': '✅',
        'Resolved': '✅',
        'Pending Confirmation': '⏳',
        'Cancelled': '❌',
        'Logged (No Action)': '📋',
      };

      // Susun teks header ringkas
      let headerText = `🔍 <b>Hasil: ${escapeHTML(queryLabel)}</b> — ${displayTickets.length} tiket`;
      if (tickets.length > 8) headerText += ` (dari ${tickets.length})`;
      headerText += '\n\nPilih tiket yang ingin diedit 👇';

      // Buat inline keyboard — 1 tombol per baris
      const inline_keyboard = displayTickets.map(t => {
        const prio = priorityEmoji[(t.priority || 'MEDIUM').toUpperCase()] || '🟡';
        const stat = statusShort[t.status] || '📄';
        const label = (t.subject || t.summary || 'Tanpa judul').substring(0, 50);
        const shortId = t.ticket_id.split('-').slice(-1)[0]; // ambil seq number saja, e.g. 0001
        const btnText = `${prio} ${stat} ${t.ticket_id.replace('TCK-', '')} · ${label}`;
        return [{ text: btnText.substring(0, 64), callback_data: `select_ticket_${t.ticket_id}` }];
      });

      await bot.sendMessage(chatId, headerText, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard }
      });

    } catch (err) {
      console.error('❌ /edit keyword handler error:', err.message);
      await bot.editMessageText(
        '❌ Gagal mencari tiket. Coba lagi.',
        { chat_id: chatId, message_id: loadingMsg.message_id }
      ).catch(() => { });
    }
  });

  // ─────── MESSAGE HANDLER ───────
  bot.on('message', async (msg) => {
    // Debugging sementara untuk melihat semua pesan masuk
    console.log('TELEGRAM MESSAGE:', {
      text: msg.text,
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      username: msg.from.username,
      from: msg.from.id,
      is_bot: msg.from.is_bot
    });


    if (!msg.text || msg.from?.is_bot) return;
    if (msg.text.startsWith('/')) return; // skip semua commands

    const chatId = msg.chat.id.toString();
    const userId = msg.from?.id?.toString() || 'unknown';
    const groupName = msg.chat.title || "Private Chat";
    const sender = msg.from?.first_name || msg.from?.username || "Unknown";

    const isMonitoredGroup = ALLOWED_TELEGRAM_GROUPS.includes(chatId);
    const isMainGroup = chatId === MAIN_CHAT_ID;

    // ── PRIORITAS 1: Cek apakah user punya sesi manual input aktif ──
    const activeSession = getSession(chatId, userId);
    if (activeSession) {
      await handleSessionMessage(msg, activeSession, chatId, userId);
      return;
    }

    // ── PRIORITAS 2: Monitored intake group → simpan langsung ke Supabase ──
    if (isMonitoredGroup) {
      console.log(`\n📩 Telegram Message Received`);
      console.log(`Group  : ${groupName} (${chatId})`);
      console.log(`From   : ${sender}`);
      console.log(`Text   : ${msg.text.substring(0, 100)}${msg.text.length > 100 ? '...' : ''}`);

      // Simpan ke tabel intake_message terlebih dahulu
      const raw = await saveRawIntakeMessage({
        source_channel: 'telegram',
        source_ref: chatId.toString(),
        sender: `${sender} (${userId})`,
        thread_ref: msg.reply_to_message?.message_id ? `tg_grp_${msg.reply_to_message.message_id}` : null,
        received_at: new Date(Number(msg.date || Date.now() / 1000) * 1000).toISOString(),
        body_text: msg.text,
        attachments: null,
        raw_payload: {
          group_name: groupName,
          telegram_msg_id: msg.message_id,
          sender_id: userId,
          push_name: sender,
        },
        idempotency_key: `tg_grp_${msg.message_id}`,
      }).catch(err => {
        console.warn('⚠️ Gagal simpan raw message Telegram group, proses tetap lanjut:', err.message);
        return null;
      });

      // Proses melalui pipeline utama
      await processRawMessage({
        ...(raw || {}),
        id: raw?.id || null,
        source_channel: 'telegram',
        source_ref: chatId.toString(),
        sender: `${sender} (${userId})`,
        body_text: msg.text,
        raw_payload: {
          group_name: groupName,
          telegram_msg_id: msg.message_id,
        },
        idempotency_key: `tg_grp_${msg.message_id}`,
      });
      return;
    }

    // ── PRIORITAS 3: Main group → balas dengan AI ──
    // Logika ini sudah dipindahkan ke command /ai untuk menghindari spam
  });

  // ─────── CALLBACK QUERY HANDLER ───────
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from?.id?.toString() || 'unknown';

    // Jangan panggil answerCallbackQuery di awal jika data berupa update status,
    // karena handleStatusChange akan memanggil answerCallbackQuery dengan toast kustom.
    if (!query.data?.startsWith('status_')) {
      await bot.answerCallbackQuery(query.id).catch(() => { });
    }

    const data = query.data;

    try {
      // ── Callback dari menu utama ──
      if (data.startsWith('status_')) {
        const newStatus = data.replace('status_', '');
        await handleStatusChange(query, chatId, newStatus);
        return;
      }

      if (data === 'main_menu') { await sendMainMenu({ chat: { id: chatId } }); return; }
      if (data === 'tickets_all') { await showTickets(chatId, null, "📋 Semua Tiket"); return; }
      if (data === 'tickets_inprogress') { await showTickets(chatId, "In Progress", "🔄 Tiket In Progress"); return; }
      if (data === 'tickets_done') { await showTickets(chatId, "Done", "✅ Tiket Selesai"); return; }
      if (data === 'today') { await showTicketsByDays(chatId, 1, "📅 Tiket Hari Ini"); return; }
      if (data === 'last7') { await showTicketsByDays(chatId, 7, "📅 Tiket 7 Hari Terakhir"); return; }
      if (data === 'last30') { await showTicketsByDays(chatId, 30, "📅 Tiket 30 Hari Terakhir"); return; }
      if (data === 'summary') { await sendDailySummary(chatId); return; }

      // ── Memulai manual input dari menu ──
      if (data === 'manual_input') {
        const fakeChatMsg = { chat: { id: chatId }, from: query.from, text: '/tiket' };
        // Emit sintetis: panggil langsung handler
        const senderName = query.from?.first_name || query.from?.username || 'Unknown';
        const chatIdStr = chatId.toString();
        const userIdStr = query.from?.id?.toString() || 'unknown';

        const existingSession = getSession(chatIdStr, userIdStr);
        if (existingSession) {
          await bot.sendMessage(chatId,
            '⚠️ Kamu sudah memiliki sesi input tiket aktif. Selesaikan atau ketik /cancel untuk membatalkan.',
            { reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Sesi', callback_data: 'manual_cancel' }]] } }
          );
          return;
        }

        createSession(chatIdStr, userIdStr, senderName);
        await bot.sendMessage(chatId,
          `✏️ <b>Input Manual Tiket Baru</b>\n\n` +
          `Halo ${escapeHTML(senderName)}! Silakan ceritakan masalah atau permintaan yang ingin didaftarkan sebagai tiket.\n\n` +
          `<i>Cukup tulis bebas, AI akan mengekstrak detailnya secara otomatis.</i>\n\n` +
          `Contoh:\n` +
          `<i>"Server SIMRS di gedung A tidak bisa diakses sejak jam 9 pagi. Dilaporkan oleh Pak Budi via telepon."</i>\n\n` +
          `Ketik pesan sekarang 👇`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '❌ Batalkan', callback_data: 'manual_cancel' }]]
            }
          }
        );
        return;
      }

      // ── Callback dari follow-up questions (prefix: fq_) ──
      if (data.startsWith('fq_')) {
        await handleFollowUpCallback(query, chatId, userId, data);
        return;
      }

      // ── Callback edit field (prefix: edit_field_) ──
      if (data.startsWith('edit_field_')) {
        await handleEditFieldCallback(query, chatId, userId, data);
        return;
      }

      // ── Konfirmasi simpan tiket ──
      if (data === 'manual_confirm') {
        await handleManualConfirm(query, chatId, userId);
        return;
      }

      // ── Batalkan sesi manual input ──
      if (data === 'manual_cancel') {
        destroySession(chatId.toString(), userId);
        try {
          await bot.editMessageText(
            '❌ Sesi input tiket dibatalkan.',
            { chat_id: chatId, message_id: query.message.message_id }
          );
        } catch (_) {
          await bot.sendMessage(chatId, '❌ Sesi input tiket dibatalkan.');
        }
        return;
      }

      // ── Draft: Fix & Publish ke Beacon (callback: draft_publish_<ticketId>) ──
      if (data.startsWith('draft_publish_')) {
        const ticketId = data.replace('draft_publish_', '');
        await handleDraftPublish(query, chatId, ticketId);
        return;
      }

      // ── Draft: Masih ada perubahan → buka repair (callback: draft_edit_<ticketId>) ──
      if (data.startsWith('draft_edit_')) {
        const ticketId = data.replace('draft_edit_', '');
        await handleDraftEdit(query, chatId, userId);
        return;
      }

      // ── Draft: Batalkan draft (callback: draft_cancel_<ticketId>) ──
      if (data.startsWith('draft_cancel_')) {
        const ticketId = data.replace('draft_cancel_', '');
        await handleDraftCancel(query, chatId, ticketId);
        return;
      }

      // ── Repair: Edit field tiket (callback: repair_edit_<field>_<ticketId>) ──
      if (data.startsWith('repair_edit_')) {
        await handleRepairEditCallback(query, chatId, userId, data);
        return;
      }

      // ── Repair: Publish update ke Beacon (callback: repair_publish_<ticketId>) ──
      if (data.startsWith('repair_publish_')) {
        const ticketId = data.replace('repair_publish_', '');
        await handleRepairPublish(query, chatId, userId, ticketId);
        return;
      }

      // -- Repair followup options (prefix: rq_) --
      if (data.startsWith('rq_')) {
        await handleRepairFollowUpCallback(query, chatId, userId, data);
        return;
      }

      // -- Konfirmasi tiket di Beacon --
      if (data.startsWith('confirm_ticket_')) {
        await handleTicketConfirm(query, chatId, data.replace('confirm_ticket_', ''));
        return;
      }

      // -- Tolak tiket di Beacon: tampilkan konfirmasi double-check --
      if (data.startsWith('reject_ticket_')) {
        await handleTicketReject(query, chatId, data.replace('reject_ticket_', ''));
        return;
      }

      // -- Konfirmasi double-check: "Ya, Bukan Tiket" --
      if (data.startsWith('confirm_reject_')) {
        await handleConfirmReject(query, chatId, data.replace('confirm_reject_', ''));
        return;
      }

      // -- Batal dari double-check: kembali ke tampilan kandidat --
      if (data.startsWith('cancel_reject_')) {
        await handleCancelReject(query, chatId, data.replace('cancel_reject_', ''));
        return;
      }

      // -- Edit tiket dari Beacon --
      if (data.startsWith('edit_beacon_ticket_')) {
        await handleBeaconEditTicket(query, chatId, data.replace('edit_beacon_ticket_', ''));
        return;
      }

      // -- Eskalasi tiket dari Beacon --
      if (data.startsWith('escalate_ticket_')) {
        await handleBeaconEscalate(query, chatId, data.replace('escalate_ticket_', ''));
        return;
      }

      // ── Pilih tiket dari hasil pencarian /edit keyword (prefix: select_ticket_) ──
      if (data.startsWith('select_ticket_')) {
        const ticketId = data.replace('select_ticket_', '');
        const senderName = query.from?.first_name || query.from?.username || 'Unknown';

        // Cek sesi aktif
        const existingSession = getSession(chatId.toString(), userId);
        if (existingSession) {
          await bot.sendMessage(chatId,
            '⚠️ Kamu masih punya sesi aktif. Selesaikan atau ketik /cancel terlebih dahulu.',
            { reply_markup: { inline_keyboard: [[{ text: '❌ Batalkan Sesi', callback_data: 'manual_cancel' }]] } }
          );
          return;
        }

        // Edit pesan list → tampilkan loading
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: chatId,
          message_id: query.message.message_id
        }).catch(() => { });

        const loadingMsg = await bot.sendMessage(chatId,
          `🔍 Membuka tiket <code>${escapeHTML(ticketId)}</code>...`,
          { parse_mode: 'HTML' }
        );

        try {
          const ticket = await getTicketById(ticketId);
          if (!ticket) {
            await bot.editMessageText(
              `❌ Tiket <code>${escapeHTML(ticketId)}</code> tidak ditemukan.`,
              { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'HTML' }
            );
            return;
          }

          createRepairSession(chatId.toString(), userId, ticket, senderName);
          await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

          const session = getSession(chatId.toString(), userId);
          const { text: repairText, keyboard: repairKeyboard } = formatRepairSummary(session);
          await bot.sendMessage(chatId, repairText, { parse_mode: 'HTML', ...repairKeyboard });

        } catch (err) {
          console.error('❌ select_ticket_ callback error:', err.message);
          await bot.editMessageText(
            '❌ Gagal membuka tiket. Coba lagi.',
            { chat_id: chatId, message_id: loadingMsg.message_id }
          ).catch(() => { });
        }
        return;
      }

    } catch (err) {
      console.error("❌ Callback error:", err.message);
      await bot.sendMessage(chatId, "Terjadi kesalahan saat memproses permintaan.");
    }
  });

  return bot;
}

// ================== HANDLER: PESAN DALAM SESI AKTIF ==================
async function handleSessionMessage(msg, session, chatId, userId) {
  const text = msg.text.trim();

  // ── State: AWAITING_TEXT → terima teks bebas, ekstrak dengan AI ──
  if (session.step === 'AWAITING_TEXT') {
    session.rawText = text;

    // Kirim pesan loading
    const loadingMsg = await bot.sendMessage(chatId,
      '🤖 AI sedang menganalisis teks kamu...',
      { parse_mode: 'HTML' }
    );

    try {
      // Ekstrak field dengan AI
      const extracted = await extractTicketFields(text);
      console.log('🔍 AI Extraction result:', JSON.stringify(extracted, null, 2));

      // Merge hasil ke session & hitung field yang perlu follow-up
      const pending = computePendingFields(extracted, session);
      session.pendingFields = pending;

      // Hapus pesan loading
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });

      // Tampilkan hasil ekstraksi ke user
      const extractedSummary = buildExtractionSummary(session.data, extracted);
      await bot.sendMessage(chatId, extractedSummary, { parse_mode: 'HTML' });

      // Lanjutkan ke follow-up atau konfirmasi
      if (pending.length === 0) {
        // Semua field terisi → langsung ke konfirmasi
        await askConfirmation(chatId, userId, session);
      } else {
        // Ada field yang perlu ditanya
        session.step = 'FOLLOWUP';
        session.currentField = pending[0];
        session.pendingFields = pending.slice(1);
        await askNextField(chatId, userId, session);
      }

    } catch (err) {
      console.error('❌ handleSessionMessage error:', err.message);
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });
      await bot.sendMessage(chatId, '❌ Terjadi kesalahan saat menganalisis teks. Silakan coba lagi atau kirim ulang pesan.');
    }
    return;
  }

  // ── State: FOLLOWUP → terima jawaban teks bebas untuk field saat ini ──
  if (session.step === 'FOLLOWUP' && session.currentField) {
    const field = session.currentField;

    // Validasi input sebelum disimpan
    const validation = validateField(field, text);
    if (!validation.valid) {
      await bot.sendMessage(chatId, validation.message, { parse_mode: 'HTML' });
      return; // minta ulang tanpa maju ke field berikutnya
    }

    session.data[field] = validation.normalized || text;
    updateSession(chatId, userId, { data: session.data });

    await moveToNextField(chatId, userId, session);
    return;
  }

  // ── State: EDITING → user mengetik nilai baru untuk field yang diedit ──
  if (session.step === 'EDITING' && session.editingField) {
    const field = session.editingField;

    // Validasi nilai baru
    const validation = validateField(field, text);
    if (!validation.valid) {
      await bot.sendMessage(chatId,
        `${validation.message}\n\nSilakan kirim nilai yang valid, atau ketik /cancel untuk membatalkan.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Simpan nilai baru ke session
    session.data[field] = validation.normalized || text.trim();
    session.step = 'CONFIRM';
    session.editingField = null;
    updateSession(chatId, userId, { data: session.data, step: 'CONFIRM', editingField: null });

    await bot.sendMessage(chatId,
      `✅ <b>${escapeHTML(FIELD_LABELS[field] || field)}</b> berhasil diperbarui.`,
      { parse_mode: 'HTML' }
    );

    // Tampilkan summary konfirmasi lagi
    await askConfirmation(chatId, userId, session);
    return;
  }

  // ── State: REPAIR_EDITING → user mengetik nilai baru untuk field tiket DB ──
  if (session.step === 'REPAIR_EDITING' && session.editingField) {
    const field = session.editingField;

    // Validasi nilai baru
    const validation = validateField(field, text);
    if (!validation.valid) {
      await bot.sendMessage(chatId,
        `${validation.message}\n\nSilakan kirim nilai yang valid, atau ketik /cancel untuk membatalkan.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Simpan ke repairData (bukan data sesi biasa)
    session.repairData[field] = validation.normalized || text.trim();
    session.editingField = null;
    updateSession(chatId, userId, { repairData: session.repairData, editingField: null });

    const fieldLabel = DB_FIELD_LABELS[field] || FIELD_LABELS[field] || field;
    await bot.sendMessage(chatId,
      `✅ <b>${escapeHTML(fieldLabel)}</b> berhasil diperbarui.`,
      { parse_mode: 'HTML' }
    );

    // Tampilkan kembali repair summary dengan data terbaru
    const { text: summaryText, keyboard } = formatRepairSummary(session);
    await bot.sendMessage(chatId, summaryText, { parse_mode: 'HTML', ...keyboard });
    return;
  }
}


// ================== HANDLER: FOLLOW-UP CALLBACK (dari tombol) ==================
async function handleFollowUpCallback(query, chatId, userId, data) {
  const session = getSession(chatId.toString(), userId);
  if (!session) {
    await bot.sendMessage(chatId, '⚠️ Sesi tidak ditemukan atau sudah kedaluwarsa. Ketik /tiket untuk memulai lagi.');
    return;
  }

  // Parse callback: fq_<field>_<value> atau fq_skip_<field>
  const parts = data.replace('fq_', '').split('_');

  // Handle skip
  if (parts[0] === 'skip') {
    const skippedField = parts.slice(1).join('_');
    session.data[skippedField] = null;
    updateSession(chatId.toString(), userId, { data: session.data });

    // Edit pesan lama untuk menghapus keyboard
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: query.message.message_id
    }).catch(() => { });

    await bot.sendMessage(chatId, `⏭ Field <b>${FIELD_LABELS[skippedField] || skippedField}</b> dilewati.`, { parse_mode: 'HTML' });
    await moveToNextField(chatId.toString(), userId, session);
    return;
  }

  // Handle pilihan field (fq_<field>_<value>)
  const knownFields = ['category', 'severity', 'source', 'issue_type', 'project'];
  let matchedField = null;
  let matchedValue = null;

  for (const f of knownFields) {
    const dataSuffix = data.replace(`fq_${f}_`, '');
    if (data.startsWith(`fq_${f}_`) && dataSuffix.length > 0) {
      matchedField = f;
      matchedValue = dataSuffix;
      break;
    }
  }

  if (matchedField && matchedValue) {
    session.data[matchedField] = matchedValue;
    updateSession(chatId.toString(), userId, { data: session.data });

    // Edit pesan untuk hapus keyboard
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: query.message.message_id
    }).catch(() => { });

    await bot.sendMessage(chatId, `✅ <b>${FIELD_LABELS[matchedField] || matchedField}</b>: ${escapeHTML(matchedValue)}`, { parse_mode: 'HTML' });
    await moveToNextField(chatId.toString(), userId, session);
  }
}

// ================== HANDLER: EDIT FIELD CALLBACK ==================
async function handleEditFieldCallback(query, chatId, userId, data) {
  const session = getSession(chatId.toString(), userId);
  if (!session) {
    await bot.sendMessage(chatId, '⚠️ Sesi tidak ditemukan. Ketik /tiket untuk memulai lagi.');
    return;
  }

  // Format callback: edit_field_<fieldname>
  const field = data.replace('edit_field_', '');
  if (!ALL_FIELDS.includes(field)) {
    await bot.sendMessage(chatId, '❌ Field tidak dikenali.');
    return;
  }

  // Ubah state ke EDITING
  session.step = 'EDITING';
  session.editingField = field;
  updateSession(chatId.toString(), userId, { step: 'EDITING', editingField: field });

  // Cek apakah field ini punya opsi keyboard (pilihan cepat)
  const canSkip = !isRequiredField(field);
  const { question, keyboard } = getFieldPrompt(field, canSkip);
  const fieldLabel = FIELD_LABELS[field] || field;
  const currentVal = session.data[field];

  // Hapus keyboard dari pesan konfirmasi agar tidak membingungkan
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId,
    message_id: query.message.message_id
  }).catch(() => { });

  await bot.sendMessage(chatId,
    `✏️ <b>Edit: ${escapeHTML(fieldLabel)}</b>\n` +
    `${currentVal ? `Nilai sekarang: <i>${escapeHTML(String(currentVal))}</i>\n\n` : ''}` +
    question,
    { parse_mode: 'HTML', ...keyboard }
  );
}

// ================== HANDLER: KONFIRMASI SIMPAN → KIRIM DRAFT KE UTT ==================
async function handleManualConfirm(query, chatId, userId) {
  const session = getSession(chatId.toString(), userId);
  if (!session) {
    await bot.editMessageText('⚠️ Sesi tidak ditemukan atau sudah kedaluwarsa.', {
      chat_id: chatId, message_id: query.message.message_id
    });
    return;
  }

  // Edit pesan konfirmasi → tampilkan loading
  await bot.editMessageText('⏳ Menyimpan draft tiket...', {
    chat_id: chatId,
    message_id: query.message.message_id,
    reply_markup: { inline_keyboard: [] }
  });

  try {
    const ticketId = await generateTicketId();
    const d = session.data;

    // Simpan ke DB dengan status DRAFT
    const emailObj = {
      id: ticketId,
      from: d.requester || session.senderName,
      subject: `[Manual] ${d.description ? d.description.substring(0, 80) : 'Tiket Manual'}`,
      body: session.rawText || d.description,
      source: d.source || 'telegram_manual',
      group_name: 'Manual Input'
    };

    const analysis = {
      category: d.category || 'Incident Management',
      severity: d.severity || 'medium',
      priority: (d.severity || 'medium').toUpperCase(),
      summary: d.description,
      project: d.project,
      requester: d.requester,
      reported_time: d.reported_time,
      issue_type: d.issue_type,
      confidence_score: 100,  // manual input selalu confident
    };

    // Simpan ke Supabase dengan status Draft
    await saveEmailLog(
      { ...emailObj, status: 'Draft' },
      { ...analysis, status: 'Draft' },
      false,   // belum telegram_sent
      null,
      null
    );

    // Update status ke Draft (saveEmailLog mungkin set In Progress)
    await updateTicket(ticketId, { status: 'Draft' });

    // Destroy sesi user
    destroySession(chatId.toString(), userId);

    // Konfirmasi ke user (chat pribadi / tempat user chatting)
    await bot.editMessageText(
      `✅ <b>Draft tiket tersimpan!</b>\n\n` +
      `📌 Ticket ID: <code>${ticketId}</code>\n` +
      `Draft telah dikirim ke grup UTT untuk konfirmasi akhir.\n\n` +
      `Ketik /menu untuk kembali ke menu utama.`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
    );

    // Kirim DRAFT ke grup UTT untuk pre-konfirmasi
    const UTT_CHAT_ID = (env.TG_UTT_CHAT_ID || '-1003753882093').trim();
    const { text: draftText, keyboard: draftKeyboard } = formatDraftForUTT(session, ticketId);

    // Tambahkan rawText ke session agar data tersedia di formatDraftForUTT (sudah destroyed, pakai local)
    // Buat ulang session object sementara untuk formatting
    const tempSession = { data: d, senderName: session.senderName };
    const { text: draftMsg, keyboard: draftKb } = formatDraftForUTT(tempSession, ticketId);

    await bot.sendMessage(UTT_CHAT_ID, draftMsg, {
      parse_mode: 'HTML',
      ...draftKb
    });

  } catch (err) {
    console.error('❌ handleManualConfirm error:', err.message);
    destroySession(chatId.toString(), userId);
    await bot.sendMessage(chatId, '❌ Gagal menyimpan tiket. Silakan coba lagi dengan /tiket baru.');
  }
}

// ================== HANDLER: DRAFT FIX & PUBLISH KE BEACON ==================
async function handleDraftPublish(query, chatId, ticketId) {
  const BEACON_CHAT_ID = (env.TG_BEACON_CHAT_ID || '-5546265953').trim();

  // Edit pesan draft di UTT → loading
  try {
    await bot.editMessageText(
      `⏳ Mempublish tiket <code>${escapeHTML(ticketId)}</code> ke Beacon...`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  } catch (_) { }

  try {
    // Ambil tiket dari DB
    const ticket = await getTicketById(ticketId);
    if (!ticket) {
      await bot.sendMessage(chatId, `❌ Tiket <code>${escapeHTML(ticketId)}</code> tidak ditemukan.`, { parse_mode: 'HTML' });
      return;
    }

    // Update status ke In Progress
    await updateTicket(ticketId, { status: 'In Progress' });

    // Kirim tiket final ke Beacon
    const beaconMsgId = await sendFinalTicketToBeacon(ticket, BEACON_CHAT_ID, 'In Progress');

    // Update pesan di UTT → publish berhasil
    try {
      await bot.editMessageText(
        `✅ <b>Tiket berhasil dipublish ke Beacon!</b>\n\n` +
        `🎫 Ticket ID: <code>${escapeHTML(ticketId)}</code>\n` +
        `Status: <b>In Progress</b>\n\n` +
        `Tiket telah dikirim ke grup Beacon Hutabyte.`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
      );
    } catch (_) { }

  } catch (err) {
    console.error('handleDraftPublish error:', err.message);
    await bot.sendMessage(chatId, `Gagal mempublish tiket. Error: ${err.message}`);
  }
}

// -- Konfirmasi tiket: L1 klik "✅ Ini Tiket" di Beacon --
async function handleTicketConfirm(query, chatId, ticketId) {
  try {
    const now = new Date().toISOString();
    await updateTicket(ticketId, {
      status: 'In Progress',
      confirmed_at: now,
      confirmed_by: query.from?.first_name || query.from?.username || 'L1',
      sla_deadline_minutes: 120,   // SLA Pekerjaan default 2 Jam
    });

    const ticket = await getTicketById(ticketId);
    if (ticket) {
      // Edit pesan kandidat → tampilkan format TIKET DIKONFIRMASI + tombol Edit & Eskalasi
      const confirmedText = formatConfirmedTicketMessage({ ...ticket, status: 'In Progress' });
      await bot.editMessageText(confirmedText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✏️ Edit Tiket', callback_data: `edit_beacon_ticket_${ticketId}` },
              { text: '⬆️ Eskalasi', callback_data: `escalate_ticket_${ticketId}` },
            ]
          ]
        }
      }).catch(() => { });

      // Kirim notifikasi SLA Pekerjaan mulai berjalan
      const confirmedBy = query.from?.first_name || query.from?.username || 'Tim';
      const confirmedTime = new Date(now).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short',
        year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      await bot.sendMessage(chatId,
        `✅ <b>TIKET DIKONFIRMASI — SLA Pekerjaan Dimulai</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎫 Ticket ID      : <code>${escapeHTML(ticketId)}</code>\n` +
        `👤 Dikonfirmasi   : <b>${escapeHTML(confirmedBy)}</b>\n` +
        `⏰ Waktu          : ${escapeHTML(confirmedTime)}\n` +
        `⏱ SLA Pekerjaan  : <b>2 Jam (Sedang Berjalan)</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 Status         : 🔄 In Progress\n` +
        `🚀 Pesan berhasil diteruskan ke Unified Ticket Table & ClickUp.`,
        { parse_mode: 'HTML' }
      ).catch(() => { });

      // Push ke ClickUp
      try {
        const { handleL1Approve } = await import('../../usecases/processRawMessage.js');
        await handleL1Approve(ticket);
      } catch (_) { }
    }

    await bot.answerCallbackQuery(query.id, { text: `✅ Tiket ${ticketId} dikonfirmasi! SLA Pekerjaan 2 Jam dimulai.`, show_alert: true });
    console.log(`[Confirm] Tiket ${ticketId} oleh ${query.from?.first_name || 'L1'}`);
  } catch (err) {
    console.error('handleTicketConfirm error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan. Coba lagi.', show_alert: true });
  }
}

// -- Tolak tiket: L1 klik "❌ Bukan Tiket" di Beacon → tampilkan konfirmasi double-check --
async function handleTicketReject(query, chatId, ticketId) {
  try {
    // Ambil subject tiket untuk konfirmasi
    const ticket = await getTicketById(ticketId);
    const subject = escapeHTML(ticket?.subject || ticket?.body?.substring(0, 60) || '-');

    // Tampilkan konfirmasi ulang (double-check) tanpa mengubah pesan asli
    await bot.answerCallbackQuery(query.id, { text: '⚠️ Konfirmasi diperlukan', show_alert: false });

    // Kirim pesan konfirmasi double-check sebagai reply
    await bot.sendMessage(chatId,
      `⚠️ <b>KONFIRMASI</b>\n\n` +
      `Apakah pesan ini benar-benar bukan tiket?\n\n` +
      `📌 Pesan:\n<i>${subject}</i>`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Ya, Bukan Tiket', callback_data: `confirm_reject_${ticketId}` },
              { text: '↩️ Batal', callback_data: `cancel_reject_${ticketId}` },
            ]
          ]
        }
      }
    );

    console.log(`[Reject-DoubleCheck] Konfirmasi double-check ditampilkan untuk ${ticketId}`);
  } catch (err) {
    console.error('handleTicketReject error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan. Coba lagi.', show_alert: true });
  }
}

// -- Double-check: L1 klik "✅ Ya, Bukan Tiket" → set BUKAN TIKET --
async function handleConfirmReject(query, chatId, ticketId) {
  try {
    const by = query.from?.first_name || query.from?.username || 'L1';
    const now = new Date().toISOString();
    const rejectedTime = new Date(now).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short',
      year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });

    await updateTicket(ticketId, {
      status: 'Cancelled',
      rejected_by: by,
      rejected_at: now,
    });

    // Edit pesan konfirmasi double-check → tampilkan hasil BUKAN TIKET
    await bot.editMessageText(
      `❌ <b>BUKAN TIKET</b>\n\n` +
      `🆔 Intake ID     : <code>${escapeHTML(ticketId)}</code>\n` +
      `👤 Ditandai oleh : ${escapeHTML(by)}\n` +
      `⏰ Waktu         : ${escapeHTML(rejectedTime)}\n\n` +
      `ℹ️ Pesan tidak diteruskan ke Unified Ticket Table dan ClickUp.`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      }
    ).catch(() => { });

    await bot.answerCallbackQuery(query.id, { text: `Tiket ${ticketId} ditandai bukan tiket.`, show_alert: true });
    console.log(`[Reject-Confirmed] Tiket ${ticketId} ditolak oleh ${by}`);
  } catch (err) {
    console.error('handleConfirmReject error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan. Coba lagi.', show_alert: true });
  }
}

// -- Double-check: L1 klik "↩️ Batal" → hapus pesan konfirmasi, biarkan tiket tetap --
async function handleCancelReject(query, chatId, ticketId) {
  try {
    // Hapus pesan double-check saja
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
    await bot.answerCallbackQuery(query.id, { text: 'Dibatalkan. Tiket tetap aktif.', show_alert: false });
    console.log(`[Reject-Cancelled] Penolakan ${ticketId} dibatalkan`);
  } catch (err) {
    console.error('handleCancelReject error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan.', show_alert: true });
  }
}

// ================== HANDLER: EDIT TIKET DARI BEACON ==================
async function handleBeaconEditTicket(query, chatId, ticketId) {
  const UTT_CHAT_ID = (env.TG_UTT_CHAT_ID || '-1003753882093').trim();
  const senderName = query.from?.first_name || query.from?.username || 'Unknown';
  const userId = query.from?.id?.toString() || 'unknown';

  try {
    // Hapus keyboard dari pesan Beacon
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: query.message.message_id
    }).catch(() => { });

    // Ambil tiket dari DB
    const ticket = await getTicketById(ticketId);
    if (!ticket) {
      await bot.sendMessage(chatId, `❌ Tiket <code>${escapeHTML(ticketId)}</code> tidak ditemukan.`, { parse_mode: 'HTML' });
      return;
    }

    // Buat sesi repair di UTT
    createRepairSession(UTT_CHAT_ID, userId, ticket, senderName);
    const session = getSession(UTT_CHAT_ID, userId);

    const { text, keyboard } = formatRepairSummary(session);
    await bot.sendMessage(UTT_CHAT_ID, `✏️ <b>Edit Tiket dari Beacon</b>\n🎫 Ticket ID: <code>${escapeHTML(ticketId)}</code>\n\n${text}`, {
      parse_mode: 'HTML',
      ...keyboard
    });

    await bot.answerCallbackQuery(query.id, { text: `Sesi edit tiket ${ticketId} dibuka di grup UTT.`, show_alert: true });
    console.log(`[BeaconEdit] Tiket ${ticketId} dibuka untuk edit oleh ${senderName}`);
  } catch (err) {
    console.error('handleBeaconEditTicket error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan. Coba lagi.', show_alert: true });
  }
}

// ================== HANDLER: ESKALASI TIKET DARI BEACON ==================
async function handleBeaconEscalate(query, chatId, ticketId) {
  try {
    // Update status tiket ke Escalated
    await updateTicket(ticketId, { status: 'Escalated', escalated_at: new Date().toISOString() });

    const by = query.from?.first_name || query.from?.username || 'L1';
    const ticket = await getTicketById(ticketId);
    const severity = (ticket?.priority || ticket?.severity || 'MEDIUM').toUpperCase();
    const sevEmoji = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢', EMERGENCY: '🔴' }[severity] || '⚪';

    // Edit keyboard dari pesan Beacon → hapus tombol
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: query.message.message_id
    }).catch(() => { });

    // Kirim notifikasi eskalasi ke Beacon
    await bot.sendMessage(chatId,
      `⬆️ <b>Tiket Dieskala ke Head / Service Lead!</b>\n\n` +
      `🎫 Ticket ID  : <code>${escapeHTML(ticketId)}</code>\n` +
      `${sevEmoji} Severity   : <b>${escapeHTML(severity)}</b>\n` +
      `📌 Subjek     : ${escapeHTML(ticket?.subject || '-')}\n` +
      `👤 Dieskalasi : <b>${escapeHTML(by)}</b>\n` +
      `📊 Status     : <b>Escalated</b>\n\n` +
      `<i>Tiket ini telah diteruskan ke Head / Service Lead untuk penanganan lebih lanjut.</i>`,
      { parse_mode: 'HTML', reply_to_message_id: query.message.message_id }
    ).catch(() => { });

    // Notifikasi DM ke jeremy & fahrezy (jika env var tersedia)
    const leads = [env.TG_JEREMY_ID, env.TG_FAHREZY_ID].filter(Boolean);
    if (leads.length > 0) {
      const leadMsg =
        `⬆️ <b>ESKALASI TIKET — dari ${escapeHTML(by)}</b>\n\n` +
        `🎫 Ticket ID  : <code>${escapeHTML(ticketId)}</code>\n` +
        `${sevEmoji} Severity   : <b>${escapeHTML(severity)}</b>\n` +
        `📌 Subjek     : ${escapeHTML(ticket?.subject || '-')}\n\n` +
        `Tiket ini dieskalasi oleh <b>${escapeHTML(by)}</b> dan memerlukan penanganan Anda sebagai Head / Service Lead.`;

      for (const leadId of leads) {
        try {
          await bot.sendMessage(leadId.trim(), leadMsg, { parse_mode: 'HTML' });
          console.log(`[Escalate] Notif eskalasi terkirim ke lead ${leadId}`);
        } catch (leadErr) {
          console.warn(`[Escalate] Gagal kirim notif ke lead ${leadId}:`, leadErr.message);
        }
      }
    } else {
      console.warn('[Escalate] Tidak ada TG_JEREMY_ID / TG_FAHREZY_ID di .env — notif lead dilewati.');
    }

    await bot.answerCallbackQuery(query.id, { text: `Tiket ${ticketId} berhasil dieskala ke Head/Service Lead.`, show_alert: true });
    console.log(`[Escalate] Tiket ${ticketId} dieskala oleh ${by}`);
  } catch (err) {
    console.error('handleBeaconEscalate error:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan. Coba lagi.', show_alert: true });
  }
}

// ================== HANDLER: DRAFT — MASIH ADA PERUBAHAN ==================
async function handleDraftEdit(query, chatId, userId) {
  // Ekstrak ticketId dari teks pesan draft
  const messageText = query.message.text || '';
  const ticketIdMatch = messageText.match(/Ticket ID\s*:\s*(TCK-[\w-]+)/i);
  const ticketId = ticketIdMatch ? ticketIdMatch[1] : null;

  if (!ticketId) {
    await bot.sendMessage(chatId, '❌ Tidak bisa menemukan Ticket ID dari pesan ini.');
    return;
  }

  const senderName = query.from?.first_name || query.from?.username || 'Unknown';
  const userIdStr = query.from?.id?.toString() || userId.toString();

  // Cek sesi aktif
  const existingSession = getSession(chatId.toString(), userIdStr);
  if (existingSession) {
    await bot.sendMessage(chatId, '⚠️ Kamu masih punya sesi aktif. Ketik /cancel dulu.');
    return;
  }

  // Ambil tiket dari DB
  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await bot.sendMessage(chatId, `❌ Tiket <code>${escapeHTML(ticketId)}</code> tidak ditemukan.`, { parse_mode: 'HTML' });
    return;
  }

  // Buat sesi repair
  createRepairSession(chatId.toString(), userIdStr, ticket, senderName);
  const session = getSession(chatId.toString(), userIdStr);

  // Edit pesan draft → info
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: query.message.message_id
    });
  } catch (_) { }

  // Tampilkan repair summary
  const { text, keyboard } = formatRepairSummary(session);
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
}

// ================== HANDLER: DRAFT — BATALKAN ==================
async function handleDraftCancel(query, chatId, ticketId) {
  try {
    // Update status tiket ke Cancelled di DB
    await updateTicket(ticketId, { status: 'Cancelled' });

    await bot.editMessageText(
      `❌ <b>Draft tiket dibatalkan.</b>\n\n🎫 Ticket ID: <code>${escapeHTML(ticketId)}</code>\nStatus diubah ke: Cancelled`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
    );
  } catch (err) {
    console.error('❌ handleDraftCancel error:', err.message);
    await bot.sendMessage(chatId, '❌ Gagal membatalkan draft tiket.');
  }
}

// ================== HANDLER: REPAIR EDIT FIELD CALLBACK ==================
async function handleRepairEditCallback(query, chatId, userId, data) {
  // Format: repair_edit_<field>_<ticketId>
  // ticketId format: TCK-YYYYMMDD-XXXX
  // Kita perlu memisah field dari ticketId
  const withoutPrefix = data.replace('repair_edit_', '');

  // Cari titik pisah: field diikuti _ lalu TCK-...
  const tckMatch = withoutPrefix.match(/_?(TCK-.+)$/);
  if (!tckMatch) {
    await bot.sendMessage(chatId, '❌ Format callback repair tidak valid.');
    return;
  }

  const ticketId = tckMatch[1];
  const field = withoutPrefix.replace(`_${ticketId}`, '').replace(/_$/, '');

  const session = getSession(chatId.toString(), userId);
  if (!session || session.mode !== 'REPAIR') {
    await bot.sendMessage(chatId, '⚠️ Sesi repair tidak ditemukan. Ketik /get ' + ticketId + ' untuk memulai lagi.');
    return;
  }

  // Set editing field
  session.editingField = field;
  updateSession(chatId.toString(), userId, { editingField: field });

  const fieldLabel = DB_FIELD_LABELS[field] || FIELD_LABELS[field] || field;
  const currentVal = session.repairData[field] || session.repairTicket[field];

  // Hapus keyboard dari pesan repair summary
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId,
    message_id: query.message.message_id
  }).catch(() => { });

  // Ambil prompt + opsi keyboard (gunakan prefix rq_ untuk repair)
  const { question, keyboard } = getFieldPrompt(field, true, 'rq');

  await bot.sendMessage(chatId,
    `✏️ <b>Edit: ${escapeHTML(fieldLabel)}</b>\n` +
    `${currentVal ? `Nilai sekarang: <i>${escapeHTML(String(currentVal))}</i>\n\n` : '\n'}` +
    question,
    { parse_mode: 'HTML', ...keyboard }
  );
}

// ================== HANDLER: REPAIR FOLLOW-UP CALLBACK (tombol pilihan) ==================
async function handleRepairFollowUpCallback(query, chatId, userId, data) {
  // Format: rq_<field>_<value> atau rq_skip_<field>
  const session = getSession(chatId.toString(), userId);
  if (!session || session.mode !== 'REPAIR') {
    await bot.sendMessage(chatId, '⚠️ Sesi repair tidak ditemukan.');
    return;
  }

  const withoutPrefix = data.replace('rq_', '');

  // Handle skip
  if (withoutPrefix.startsWith('skip_')) {
    const skippedField = withoutPrefix.replace('skip_', '');
    session.repairData[skippedField] = null;
    session.editingField = null;
    updateSession(chatId.toString(), userId, { repairData: session.repairData, editingField: null });

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    }).catch(() => { });

    const fieldLabel = DB_FIELD_LABELS[skippedField] || FIELD_LABELS[skippedField] || skippedField;
    await bot.sendMessage(chatId, `⏭ Field <b>${escapeHTML(fieldLabel)}</b> dilewati.`, { parse_mode: 'HTML' });

    // Tampilkan kembali repair summary
    const { text: summaryText, keyboard } = formatRepairSummary(session);
    await bot.sendMessage(chatId, summaryText, { parse_mode: 'HTML', ...keyboard });
    return;
  }

  // Handle pilihan: rq_<field>_<value>
  const knownFields = ['priority', 'status', 'category', 'source', 'issue_type', 'project', 'severity'];
  let matchedField = null;
  let matchedValue = null;

  for (const f of knownFields) {
    if (data.startsWith(`rq_${f}_`)) {
      matchedField = f;
      matchedValue = data.replace(`rq_${f}_`, '');
      break;
    }
  }

  if (matchedField && matchedValue) {
    const validation = validateField(matchedField, matchedValue);
    session.repairData[matchedField] = validation.normalized || matchedValue;
    session.editingField = null;
    updateSession(chatId.toString(), userId, { repairData: session.repairData, editingField: null });

    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    }).catch(() => { });

    const fieldLabel = DB_FIELD_LABELS[matchedField] || FIELD_LABELS[matchedField] || matchedField;
    await bot.sendMessage(chatId, `✅ <b>${escapeHTML(fieldLabel)}</b>: ${escapeHTML(matchedValue)}`, { parse_mode: 'HTML' });

    // Tampilkan kembali repair summary
    const { text: summaryText, keyboard } = formatRepairSummary(session);
    await bot.sendMessage(chatId, summaryText, { parse_mode: 'HTML', ...keyboard });
  }
}

// ================== HANDLER: REPAIR PUBLISH → UPDATE DB + KIRIM KE BEACON ==================
async function handleRepairPublish(query, chatId, userId, ticketId) {
  const BEACON_CHAT_ID = (env.TG_BEACON_CHAT_ID || '-5546265953').trim();

  const session = getSession(chatId.toString(), userId);
  if (!session || session.mode !== 'REPAIR') {
    await bot.sendMessage(chatId, '⚠️ Sesi repair tidak ditemukan. Ketik /get ' + ticketId + ' untuk memulai lagi.');
    return;
  }

  // Edit pesan → loading
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId, message_id: query.message.message_id
    });
  } catch (_) { }

  await bot.sendMessage(chatId, `⏳ Menyimpan perubahan dan re-publishing tiket <code>${escapeHTML(ticketId)}</code>...`, { parse_mode: 'HTML' });

  try {
    const originalTicket = session.repairTicket;
    const repairData = session.repairData;

    // Buat payload update — JANGAN sentuh processed_at dan ticket_id
    const updatePayload = {};
    const allowedUpdateFields = ['from', 'subject', 'body', 'summary', 'category', 'priority', 'source', 'status'];

    for (const field of allowedUpdateFields) {
      if (repairData[field] !== undefined && repairData[field] !== originalTicket[field]) {
        updatePayload[field] = repairData[field];
      }
    }

    if (Object.keys(updatePayload).length > 0) {
      const success = await updateTicket(ticketId, updatePayload);
      if (!success) {
        await bot.sendMessage(chatId, '❌ Gagal menyimpan perubahan ke database.');
        return;
      }
      console.log(`✅ Repair tiket ${ticketId} — fields updated:`, Object.keys(updatePayload).join(', '));
    } else {
      console.log(`ℹ️ Repair tiket ${ticketId} — tidak ada field yang berubah.`);
    }

    // Destroy sesi repair
    destroySession(chatId.toString(), userId);

    // Ambil data tiket terbaru dari DB
    const updatedTicket = await getTicketById(ticketId);

    // Kirim pesan update ke Beacon
    await sendFinalTicketToBeacon(updatedTicket || { ...originalTicket, ...updatePayload }, BEACON_CHAT_ID, updatedTicket?.status || originalTicket.status, true);

    await bot.sendMessage(chatId,
      `✅ <b>Tiket berhasil diupdate dan re-published ke Beacon!</b>\n\n` +
      `🎫 Ticket ID: <code>${escapeHTML(ticketId)}</code>\n` +
      `📅 Tanggal awal tiket: <i>terjaga, tidak berubah</i>\n\n` +
      `Ketik /menu untuk kembali ke menu utama.`,
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    console.error('❌ handleRepairPublish error:', err.message);
    destroySession(chatId.toString(), userId);
    await bot.sendMessage(chatId, `❌ Gagal re-publish tiket. Error: ${err.message}`);
  }
}

// ================== HELPER: FORMAT PESAN KANDIDAT TIKET (untuk Beacon) ==================
function formatCandidateTicketMessage(ticket) {
  const channelMap = {
    email: 'Email', telegram: 'Telegram – Grup',
    telegram_manual: 'Telegram – Manual', telegram_personal: 'Telegram – Direct Message',
    whatsapp: 'WhatsApp', wa_group: 'WhatsApp – Grup', wa_dm: 'WhatsApp – Direct Message',
    telepon: 'Telepon', 'walk-in': 'Walk-in',
  };
  const channel = channelMap[(ticket.source || '').toLowerCase()] || (ticket.source || 'System');

  const diterima = ticket.processed_at
    ? new Date(ticket.processed_at).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short',
        year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '-';

  const severity = ticket.priority || ticket.severity || null;
  const priority = ticket.priority || null;
  const category = ticket.category || null;
  // Intake ID: gunakan ticket_id sebagai referensi (format TCK-YYYYMMDD-XXXX)
  const intakeId = ticket.ticket_id || ticket.id || '-';
  const statusLabel = 'Menunggu Konfirmasi (SLA: 15 Menit)';

  const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

  return (
    `📥 <b>KANDIDAT TIKET BARU</b>\n` +
    `${DIVIDER}\n` +
    `🆔 Intake ID   : <code>${escapeHTML(intakeId)}</code>\n` +
    `📅 Diterima    : ${escapeHTML(diterima)}\n` +
    `${DIVIDER}\n` +
    `📡 Channel     : ${escapeHTML(channel)}\n` +
    `👤 Dari        : ${escapeHTML(ticket.from || '-')}\n` +
    `📌 Subject     : ${escapeHTML(ticket.subject || '-')}\n` +
    `${DIVIDER}\n` +
    `🗂 Kategori    : ${escapeHTML(category || 'Belum diisi')}\n` +
    `⚠️ Severity    : ${escapeHTML(severity ? severity.toUpperCase() : 'Belum diisi')}\n` +
    `🟡 Priority    : ${escapeHTML(priority ? priority.toUpperCase() : 'Belum diisi')}\n` +
    `📋 Status      : ${escapeHTML(statusLabel)}\n` +
    `${DIVIDER}\n` +
    `🗒 Ringkasan: ${escapeHTML(ticket.summary || '-')}\n\n` +
    `💬 Pesan Asli:\n${escapeHTML((ticket.body || '-').substring(0, 500))}` +
    ((ticket.body || '').length > 500 ? '\n<i>...pesan terpotong</i>' : '') +
    `\n\n<i>Apakah pesan ini merupakan tiket?</i>`
  );
}

// ================== HELPER: FORMAT PESAN TIKET DIKONFIRMASI (setelah ✅) ==================
function formatConfirmedTicketMessage(ticket) {
  const channelMap = {
    email: 'Email', telegram: 'Telegram – Grup',
    telegram_manual: 'Telegram – Manual', telegram_personal: 'Telegram – Direct Message',
    whatsapp: 'WhatsApp', wa_group: 'WhatsApp – Grup', wa_dm: 'WhatsApp – Direct Message',
    telepon: 'Telepon', 'walk-in': 'Walk-in',
  };
  const channel = channelMap[(ticket.source || '').toLowerCase()] || (ticket.source || 'System');

  const diterima = ticket.processed_at
    ? new Date(ticket.processed_at).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short',
        year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      })
    : '-';

  const severity = ticket.priority || ticket.severity || '-';
  const category = ticket.category || '-';
  const statusMap = {
    'In Progress': '🔄 In Progress', 'Done': '✅ Resolved (Done)', 'Resolved': '✅ Resolved',
    'Escalated': '⬆️ Escalated', 'Cancelled': '❌ Cancelled', 'Draft': '📝 Draft',
    'Open': '⏳ Open',
  };
  const statusLabel = statusMap[ticket.status] || ticket.status || '🔄 In Progress';

  const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

  return (
    `✅ <b>TIKET DIKONFIRMASI</b>\n` +
    `${DIVIDER}\n` +
    `🎫 Ticket ID   : <code>${escapeHTML(ticket.ticket_id || '-')}</code>\n` +
    `📅 Diterima    : ${escapeHTML(diterima)}\n` +
    `📡 Channel     : ${escapeHTML(channel)}\n` +
    `👤 Dari        : ${escapeHTML(ticket.from || '-')}\n` +
    `📌 Subject     : ${escapeHTML(ticket.subject || '-')}\n` +
    `${DIVIDER}\n` +
    `🗂 Kategori    : ${escapeHTML(category)}\n` +
    `⚠️ Severity    : ${escapeHTML(severity.toUpperCase())}\n` +
    `🔄 Status      : ${escapeHTML(statusLabel)}\n` +
    `${DIVIDER}\n` +
    `🗒 Summary: ${escapeHTML(ticket.summary || '-')}\n` +
    `📝 Isi Pesan: ${escapeHTML((ticket.body || '-').substring(0, 500))}` +
    ((ticket.body || '').length > 500 ? '\n<i>...pesan terpotong</i>' : '') +
    `\n\n<i>✅ Tiket dikonfirmasi. Timer SLA mulai berjalan.</i>`
  );
}

// ================== HELPER: KIRIM KANDIDAT TIKET KE GRUP BEACON ==================
async function sendFinalTicketToBeacon(ticket, beaconChatId, status = 'In Progress', isUpdate = false) {
  const botInstance = initTelegramBot();

  // Untuk UPDATE tiket (repair/edit), gunakan format konfirmasi dengan tombol Edit & Eskalasi
  // Untuk TIKET BARU, gunakan format KANDIDAT dengan tombol Ini Tiket & Bukan Tiket
  let messageText;
  let keyboard;

  if (isUpdate) {
    // Re-publish setelah edit: tampilkan format dikonfirmasi + tombol edit/eskalasi
    messageText = formatConfirmedTicketMessage({ ...ticket, status });
    keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ Edit Tiket', callback_data: `edit_beacon_ticket_${ticket.ticket_id}` },
            { text: '⬆️ Eskalasi', callback_data: `escalate_ticket_${ticket.ticket_id}` },
          ]
        ]
      }
    };
  } else {
    // Tiket baru: tampilkan sebagai KANDIDAT
    messageText = formatCandidateTicketMessage({ ...ticket, status });
    keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ini Tiket', callback_data: `confirm_ticket_${ticket.ticket_id}` },
            { text: '❌ Bukan Tiket', callback_data: `reject_ticket_${ticket.ticket_id}` },
          ]
        ]
      }
    };
  }

  try {
    const sent = await botInstance.sendMessage(beaconChatId, messageText, {
      parse_mode: 'HTML', ...keyboard,
    });

    if (ticket.ticket_id && sent?.message_id) {
      await updateTicket(ticket.ticket_id, {
        telegram_sent: true,
        telegram_message_id: sent.message_id.toString(),
        telegram_chat_id: beaconChatId,
      });
    }

    console.log(`Tiket ${ticket.ticket_id} terkirim ke Beacon (msg: ${sent?.message_id})`);
    return sent?.message_id;
  } catch (err) {
    console.error(`Gagal kirim tiket ke Beacon:`, err.message);
    return null;
  }
}


// ================== HELPER: LANJUT KE FIELD BERIKUTNYA ==================
async function moveToNextField(chatId, userId, session) {
  if (session.pendingFields.length === 0) {
    // Tidak ada field pending lagi → tampilkan konfirmasi
    session.step = 'CONFIRM';
    session.currentField = null;
    await askConfirmation(chatId, userId, session);
  } else {
    // Ambil field berikutnya
    const nextField = session.pendingFields[0];
    session.pendingFields = session.pendingFields.slice(1);
    session.currentField = nextField;
    session.step = 'FOLLOWUP';
    updateSession(chatId, userId, {
      pendingFields: session.pendingFields,
      currentField: nextField,
      step: 'FOLLOWUP'
    });
    await askNextField(chatId, userId, session);
  }
}

// ================== HELPER: KIRIM PERTANYAAN FOLLOW-UP ==================
async function askNextField(chatId, userId, session) {
  const field = session.currentField;
  const canSkip = !isRequiredField(field);
  const { question, keyboard } = getFieldPrompt(field, canSkip);

  const requiredLabel = isRequiredField(field) ? ' <b>(wajib diisi)</b>' : ' <i>(opsional)</i>';
  const fieldLabel = FIELD_LABELS[field] || field;

  await bot.sendMessage(chatId,
    `📋 <b>${fieldLabel}</b>${requiredLabel}\n\n${question}`,
    { parse_mode: 'HTML', ...keyboard }
  );
}

// ================== HELPER: TAMPILKAN KONFIRMASI AKHIR ==================
async function askConfirmation(chatId, userId, session) {
  const { text, keyboard } = formatSessionSummary(session);
  session.step = 'CONFIRM';
  updateSession(chatId, userId, { step: 'CONFIRM' });
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...keyboard });
}

// ================== HELPER: RINGKASAN HASIL AI EXTRACTION ==================
function buildExtractionSummary(data, extracted) {
  const fields = [
    { key: 'description', label: '📝 Deskripsi', emoji: '' },
    { key: 'category', label: '🗂 Kategori', emoji: '' },
    { key: 'severity', label: '🚦 Severity', emoji: '' },
    { key: 'project', label: '🖥 Project', emoji: '' },
    { key: 'requester', label: '👤 Pelapor', emoji: '' },
    { key: 'source', label: '📞 Sumber', emoji: '' },
    { key: 'reported_time', label: '⏰ Waktu', emoji: '' },
    { key: 'issue_type', label: '📌 Issue Type', emoji: '' },
  ];

  let text = `🤖 <b>Hasil Analisis AI</b>\n\n`;
  let found = 0;
  let missing = 0;

  for (const f of fields) {
    if (data[f.key]) {
      text += `${f.label}: ${escapeHTML(String(data[f.key]))}\n`;
      found++;
    } else {
      missing++;
    }
  }

  text += `\n<i>AI berhasil mengekstrak ${found} field, ${missing} field perlu dilengkapi.</i>`;
  return text;
}

// ================== HELPER FORMAT TIKET ==================
function formatTicketList(tickets, title) {
  if (!tickets || tickets.length === 0) {
    return `<b>${escapeHTML(title)}</b>\n\nTidak ada tiket ditemukan.`;
  }

  let text = `<b>${escapeHTML(title)}</b> (${tickets.length} tiket)\n\n`;

  tickets.slice(0, 15).forEach((ticket, index) => {
    const date = new Date(ticket.processed_at).toLocaleDateString('id-ID', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    const priorityEmoji = ticket.severity === 'emergency' ? '🔴' :
      ticket.severity === 'high' ? '🟠' : '🟡';

    text += `${index + 1}. ${priorityEmoji} <b>${escapeHTML(ticket.ticket_id)}</b>\n`;
    text += `   👤 ${escapeHTML(ticket.from || '-')}\n`;
    text += `   📌 ${escapeHTML(ticket.status || 'In Progress')}\n`;
    text += `   ⏰ ${escapeHTML(date)}\n`;
    const snippet = ticket.body ? ticket.body.substring(0, 80) + (ticket.body.length > 80 ? '...' : '') : '-';
    text += `   💬 <i>${escapeHTML(snippet)}</i>\n\n`;
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
  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
}

async function showTicketsByDays(chatId, days, title) {
  const tickets = await getTicketsByDateRange(days);
  const message = formatTicketList(tickets, title);
  await bot.sendMessage(chatId, message, { parse_mode: "HTML" });
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
function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ================== CREATE FORMAL TICKET (dipakai untuk status update di Telegram) ==================
// Untuk tiket baru ke Beacon → pakai formatCandidateTicketMessage()
// Fungsi ini dipakai untuk pesan update status (Done, Escalated, dll)
function createFormalTicket(email, analysis = {}) {
  const now = email.created_at ? new Date(email.created_at)
    : email.processed_at ? new Date(email.processed_at) : new Date();

  const diterima = now.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  const channelMap = {
    email: 'Email', telegram: 'Telegram – Grup', telegram_group: 'Telegram – Grup',
    telegram_manual: 'Telegram – Manual', telegram_personal: 'Telegram – Direct Message',
    whatsapp: 'WhatsApp', wa_group: 'WhatsApp – Grup', wa_dm: 'WhatsApp – Direct Message',
    telepon: 'Telepon', 'walk-in': 'Walk-in',
  };
  const channel = channelMap[(email.source || '').toLowerCase()] || (email.source || 'System');
  const severity = (analysis.severity || analysis.priority || email.priority || email.severity || '-');
  const category = analysis.category || email.category || '-';
  const summary = analysis.summary || email.summary || '-';
  const ticketId = email.id || email.ticket_id;

  const statusMap = {
    'Open': '⏳ Open', 'Pending Confirmation': '⏳ Pending Confirmation',
    'In Progress': '🔄 In Progress', 'Done': '✅ Resolved (Done)', 'Resolved': '✅ Resolved',
    'Escalated': '⬆️ Escalated', 'Cancelled': '❌ Cancelled', 'NoAction': '➖ No Action', 'Draft': '📝 Draft',
  };
  const statusLabel = statusMap[email.status] || email.status || '⏳ Open';

  const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

  return (
    `✅ <b>TIKET DIKONFIRMASI</b>\n` +
    `${DIVIDER}\n` +
    `🎫 Ticket ID   : <code>${escapeHTML(ticketId || '-')}</code>\n` +
    `📅 Diterima    : ${escapeHTML(diterima)}\n` +
    `📡 Channel     : ${escapeHTML(channel)}\n` +
    `👤 Dari        : ${escapeHTML(email.from || '-')}\n` +
    `📌 Subject     : ${escapeHTML(email.subject || email.group_name || '-')}\n` +
    `${DIVIDER}\n` +
    `🗂 Kategori    : ${escapeHTML(category)}\n` +
    `⚠️ Severity    : ${escapeHTML(severity ? severity.toUpperCase() : '-')}\n` +
    `🔄 Status      : ${escapeHTML(statusLabel)}\n` +
    `${DIVIDER}\n` +
    `🗒 Summary: ${escapeHTML(summary)}\n` +
    `📝 Isi Pesan: ${escapeHTML((email.body || '-').substring(0, 600))}` +
    ((email.body || '').length > 600 ? '\n<i>...pesan terpotong</i>' : '')
  );
}

// ================== SEND INCIDENT ALERT ==================
async function sendIncidentAlert(email, analysis = {}, customMessage = null) {
  const botInstance = initTelegramBot();
  // Mengirim kandidat tiket baru ke grup pre-konfirmasi & edit (TG_UTT_CHAT_ID = BTO -5546265953)
  const BEACON_ID = (env.TG_UTT_CHAT_ID || env.TG_CHAT_ID).trim();

  const activeAnalysis = analysis && Object.keys(analysis).length > 0 ? analysis : (email.analysis || {});

  // Gabungkan data email + analisis untuk kandidat tiket
  const ticketForFormat = {
    ...email,
    priority: activeAnalysis.severity || activeAnalysis.priority || email.priority || email.severity,
    category: activeAnalysis.category || email.category,
    summary: activeAnalysis.summary || email.summary,
    status: email.status || 'Draft',
    ticket_id: email.ticket_id || email.id,
  };

  // customMessage override (jika ada), kalau tidak pakai format KANDIDAT TIKET BARU
  const messageText = customMessage || email.formalMessage || formatCandidateTicketMessage(ticketForFormat);

  const severity = (activeAnalysis.severity || activeAnalysis.priority || 'medium').toLowerCase();
  const notifyLoud = ['emergency', 'critical', 'high'].includes(severity);
  const ticketId = email.ticket_id || email.id;

  let telegramMessageId = null;
  let telegramChatId = null;

  try {
    // Tombol awal KANDIDAT: hanya [✅ Ini Tiket] dan [❌ Bukan Tiket]
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ini Tiket', callback_data: `confirm_ticket_${ticketId}` },
            { text: '❌ Bukan Tiket', callback_data: `reject_ticket_${ticketId}` },
          ]
        ]
      }
    };

    const sent = await botInstance.sendMessage(BEACON_ID, messageText, {
      parse_mode: 'HTML',
      ...keyboard,
      disable_notification: !notifyLoud,
    });

    telegramMessageId = sent.message_id.toString();
    telegramChatId = sent.chat.id.toString();
    console.log(`Alert terkirim ke Beacon (msg: ${telegramMessageId})`);
  } catch (err) {
    console.error('⚠️ Gagal mengirim notifikasi alert ke Beacon:', err.message);
  }

  const dbChatId = email.group_id && telegramChatId
    ? `${telegramChatId}|${email.group_id}` : telegramChatId;

  // Set intake_received_at = waktu notifikasi kandidat dikirim (start SLA Konfirmasi 15 Menit)
  const intakeNow = new Date().toISOString();
  await saveEmailLog(
    { ...email, intake_received_at: intakeNow },
    activeAnalysis,
    !!telegramMessageId,
    telegramMessageId,
    dbChatId
  );
}

// ====================== UPDATE TICKET STATUS AND SYNC MESSAGE ======================
export async function updateIncidentStatusAndMessage(ticketId, newStatus, isAutomatic = true) {
  try {
    // 1. Ambil detail tiket dari database
    const ticket = await getTicketById(ticketId);
    if (!ticket) {
      console.warn(`⚠️ Tiket ${ticketId} tidak ditemukan untuk sinkronisasi status.`);
      return false;
    }

    // 2. Update status di database (tabel Unified_Ticket_Tracker)
    await updateTicket(ticketId, { status: newStatus });
    console.log(`✅ Status tiket ${ticketId} berhasil diubah ke ${newStatus} di database.`);

    // 3. Jika status selesai/dibatalkan, tutup sesi di tabel conversation
    if (["Done", "Resolved", "Cancelled"].includes(newStatus)) {
      await closeConversationSessionByTicket(ticketId);
    }

    // 4. Update tampilan pesan alert di Telegram jika ada
    if (ticket.telegram_chat_id && ticket.telegram_message_id) {
      const alertChatId = ticket.telegram_chat_id.split('|')[0];
      const alertMessageId = parseInt(ticket.telegram_message_id, 10);

      const statusMap = {
        Done: "✅ Resolved (Done)",
        Escalated: "🔄 Escalated",
        Cancelled: "❌ Cancelled",
        NoAction: "➖ No Action Needed"
      };
      const statusDisplay = statusMap[newStatus] || newStatus;

      // Reconstruct pesan alert utama dengan status baru
      const updatedTicketData = {
        ...ticket,
        id: ticket.ticket_id,
        status: newStatus
      };

      const newAlertMessageText = createFormalTicket(updatedTicketData);

      try {
        const botInstance = initTelegramBot();

        const isPendingToActive = newStatus === "In Progress";
        const keyboard = isPendingToActive ? {
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
        } : { inline_keyboard: [] };

        // Edit pesan utama: perbarui teks dan ganti tombol inline
        await botInstance.editMessageText(newAlertMessageText, {
          chat_id: alertChatId,
          message_id: alertMessageId,
          parse_mode: "HTML",
          reply_markup: keyboard
        });

        // Kirim notifikasi balasan (reply) hanya jika perubahan status dideteksi secara otomatis dari chat (AI)
        if (isAutomatic) {
          const statusAlertText = `🔔 <b>Status Update</b>\nTiket <code>${ticketId}</code> telah otomatis diubah statusnya menjadi <b>${statusDisplay}</b> berdasarkan balasan tim teknis.`;
          await botInstance.sendMessage(alertChatId, statusAlertText, {
            parse_mode: "HTML",
            reply_to_message_id: alertMessageId
          });
        }
      } catch (tgErr) {
        console.warn(`⚠️ Gagal memperbarui pesan alert Telegram untuk tiket ${ticketId}:`, tgErr.message);
      }
    }
    return true;
  } catch (err) {
    console.error(`❌ Error in updateIncidentStatusAndMessage:`, err);
    return false;
  }
}

// ================== HANDLE STATUS CHANGE ==================
async function handleStatusChange(query, chatId, newStatus) {
  const messageText = query.message.text || query.message.caption || "";
  const ticketIdMatch = messageText.match(/Ticket ID\s*:\s*([A-Z0-9-]+)/i);
  const ticketId = ticketIdMatch ? ticketIdMatch[1] : null;

  if (ticketId) {
    await updateIncidentStatusAndMessage(ticketId, newStatus, false);

    // ── L1 Approve: jika status berubah ke "In Progress" (dari Pending Confirmation) ──
    // Ini berarti L1 baru saja klik "Approve" → push tiket ke ClickUp
    if (newStatus === 'In Progress') {
      try {
        const { getTicketById: fetchTicket } = await import('../../database/supabase.js');
        const { handleL1Approve } = await import('../../usecases/processRawMessage.js');
        const ticket = await fetchTicket(ticketId);
        if (ticket) await handleL1Approve(ticket);
      } catch (approveErr) {
        console.warn(`⚠️ L1 Approve ClickUp push error (tidak kritis): ${approveErr.message}`);
      }
    }
  } else {
    // Fallback jika tidak menemukan Ticket ID di teks
    const messageId = query.message.message_id;
    await updateIncidentStatus(messageId.toString(), newStatus);

    const statusMap = {
      Done: "✅ Resolved (Done)",
      Escalated: "🔄 Escalated",
      Cancelled: "❌ Cancelled",
      NoAction: "➖ No Action Needed"
    };
    const statusDisplay = statusMap[newStatus] || newStatus;
    const cleanText = messageText.replace(/Status\s*:\s*.*/i, `Status        : ${statusDisplay}`);
    try {
      await bot.editMessageText(cleanText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] }
      });
    } catch (tgErr) {
      if (!tgErr.message.includes("message is not modified")) {
        console.warn("⚠️ Gagal memperbarui pesan alert fallback:", tgErr.message);
      }
    }
  }

  const statusMap = {
    Done: "✅ Resolved (Done)",
    Escalated: "🔄 Escalated",
    Cancelled: "❌ Cancelled",
    NoAction: "➖ No Action Needed",
    "In Progress": "✅ Dikonfirmasi (In Progress)"
  };
  const statusDisplay = statusMap[newStatus] || newStatus;

  await bot.answerCallbackQuery(query.id, {
    text: `✅ Status diubah menjadi: ${statusDisplay}`,
    show_alert: true
  });
}


// ================== MENU & INFO ==================
async function sendGroupInfo(msg) {
  const text = `📌 <b>Group Information</b>\n\n` +
    `Group ID   : <code>${escapeHTML(msg.chat.id.toString())}</code>\n` +
    `Nama Grup  : ${escapeHTML(msg.chat.title || "Private Chat")}\n` +
    `Tipe       : ${escapeHTML(msg.chat.type)}`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
}

async function sendMainMenu(msg) {
  const text = `🛠️ *Unified Incident Management Bot*\n\nSilakan pilih menu:`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✏️ Input Manual Tiket", callback_data: "manual_input" }],
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

export {
  initTelegramBot,
  sendIncidentAlert
};
