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
  updateTicket,
  generateTicketId,
  findActiveTicketForThreading,
  findActiveTicketsForGroup,
  appendMessageToTicket,
  createConversationSession,
  updateConversationLastMessage,
  closeConversationSessionByTicket
} from '../../database/supabase.js';
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
  getSession,
  destroySession,
  updateSession,
  computePendingFields,
  isRequiredField,
  getFieldPrompt,
  formatSessionSummary,
  FIELD_LABELS,
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

  // ─────── COMMAND HANDLERS ───────
  bot.onText(/\/menu|\/start/i, async (msg) => await sendMainMenu(msg));
  bot.onText(/\/getgroupid/i, async (msg) => await sendGroupInfo(msg));

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

  // ─────── MESSAGE HANDLER ───────
  bot.on('message', async (msg) => {
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
            const targetChatId = parentTicket.telegram_chat_id.split('|')[0];
            const replyText = `💬 <b>Balasan dari ${sender} (Telegram Group - Ticket ${parentTicket.ticket_id})</b>:\n\n${msg.text}`;
            await bot.sendMessage(targetChatId, replyText, {
              parse_mode: "HTML",
              reply_to_message_id: parseInt(parentTicket.telegram_message_id, 10)
            });
            console.log(`✅ Balasan berhasil diteruskan ke Telegram Utama (reply_to_message_id: ${parentTicket.telegram_message_id})`);
          } catch (tgErr) {
            console.error("⚠️ Gagal meneruskan balasan ke Telegram Utama:", tgErr.message);
          }
        }

        // 3. Cek apakah balasan ini menyatakan perubahan status (Done, Escalated, Cancelled)
        try {
          const detectedStatus = await detectStatusChangeFromReply(msg.text);
          if (detectedStatus && detectedStatus !== 'no_change') {
            await updateIncidentStatusAndMessage(parentTicket.ticket_id, detectedStatus, true);
          }
        } catch (statusErr) {
          console.error("⚠️ Gagal memproses deteksi status otomatis dari balasan Telegram:", statusErr.message);
        }

        return; // Hentikan alur, jangan buat tiket baru!
      }

      // === BUKAN FOLLOW-UP: BUAT TIKET BARU ===
      const ticketId = await generateTicketId();
      const pseudoEmail = {
        id: ticketId,
        messageId: msg.message_id.toString(), // Actual Telegram message ID
        from: `${sender}`,
        subject: `Laporan dari ${groupName}`,
        body: msg.text,
        source: "telegram_group",
        group_name: groupName,
        group_id: chatId
      };

      const analysis = await analyzeEmail(pseudoEmail);

      await sendIncidentAlert(pseudoEmail, analysis);

      // Buat sesi conversation baru di database
      await createConversationSession('telegram_group', chatId, pseudoEmail.id, msg.text, analysis?.summary || null);
      return;
    }

    // ── PRIORITAS 3: Main group → balas dengan AI ──
    if (isMainGroup) {
      const aiReply = await chatWithAI(msg.text);
      await bot.sendMessage(chatId, aiReply, { parse_mode: "Markdown" });
      return;
    }
  });

  // ─────── CALLBACK QUERY HANDLER ───────
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from?.id?.toString() || 'unknown';
    await bot.answerCallbackQuery(query.id);

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

      // ── Konfirmasi simpan tiket ──
      if (data === 'manual_confirm') {
        await handleManualConfirm(query, chatId, userId);
        return;
      }

      // ── Batalkan sesi manual input ──
      if (data === 'manual_cancel') {
        destroySession(chatId.toString(), userId);
        await bot.editMessageText(
          '❌ Sesi input tiket dibatalkan.',
          { chat_id: chatId, message_id: query.message.message_id }
        );
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
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

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
      await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      await bot.sendMessage(chatId, '❌ Terjadi kesalahan saat menganalisis teks. Silakan coba lagi atau kirim ulang pesan.');
    }
    return;
  }

  // ── State: FOLLOWUP → terima jawaban teks bebas untuk field saat ini ──
  if (session.step === 'FOLLOWUP' && session.currentField) {
    const field = session.currentField;
    session.data[field] = text;
    updateSession(chatId, userId, { data: session.data });

    await moveToNextField(chatId, userId, session);
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
    }).catch(() => {});

    await bot.sendMessage(chatId, `⏭ Field <b>${FIELD_LABELS[skippedField] || skippedField}</b> dilewati.`, { parse_mode: 'HTML' });
    await moveToNextField(chatId.toString(), userId, session);
    return;
  }

  // Handle pilihan field (fq_<field>_<value>)
  // Field bisa berisi underscore (mis: issue_type, reported_time)
  // Format: fq_<fieldName>_<value>  → field = parts[0], value = parts.slice(1).join('_')
  // Kita cari field yang cocok dari FIELD_OPTIONS keys: category, severity, source, issue_type, project
  const knownFields = ['category', 'severity', 'source', 'issue_type', 'project'];
  let matchedField = null;
  let matchedValue = null;

  for (const f of knownFields) {
    const fParts = f.split('_');
    // Cek apakah bagian awal dari parts cocok dengan field
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
    }).catch(() => {});

    const displayVal = matchedValue;
    await bot.sendMessage(chatId, `✅ <b>${FIELD_LABELS[matchedField] || matchedField}</b>: ${escapeHTML(displayVal)}`, { parse_mode: 'HTML' });
    await moveToNextField(chatId.toString(), userId, session);
  }
}

// ================== HANDLER: KONFIRMASI SIMPAN ==================
async function handleManualConfirm(query, chatId, userId) {
  const session = getSession(chatId.toString(), userId);
  if (!session) {
    await bot.editMessageText('⚠️ Sesi tidak ditemukan atau sudah kedaluwarsa.', {
      chat_id: chatId, message_id: query.message.message_id
    });
    return;
  }

  // Edit pesan konfirmasi → tampilkan loading
  await bot.editMessageText('⏳ Menyimpan tiket ke database...', {
    chat_id: chatId,
    message_id: query.message.message_id,
    reply_markup: { inline_keyboard: [] }
  });

  try {
    const ticketId = await generateTicketId();
    const d = session.data;

    const emailObj = {
      id: ticketId,
      from: session.senderName,
      subject: `[Manual] ${d.description ? d.description.substring(0, 80) : 'Tiket Manual'}`,
      body: session.rawText || d.description,
      source: d.source || 'telegram_manual',
      group_name: 'Manual Input'
    };

    const analysis = {
      category: d.category,
      severity: d.severity,
      summary: d.description,
      project: d.project,
      requester: d.requester,
      reported_time: d.reported_time,
      issue_type: d.issue_type,
    };

    // Format pesan alert untuk main group
    const now = new Date();
    const tanggal = now.toLocaleDateString("id-ID", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const waktu = now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

    const severityEmoji = { emergency: '🔴', high: '🟠', medium: '🟡', low: '🟢', others: '⚪' }[(d.severity || '').toLowerCase()] || '⚪';
    const sourceMap = { email: '📧 Email', telepon: '📞 Telepon', whatsapp: '💬 WhatsApp', 'walk-in': '🚶 Walk-in', telegram: '✈️ Telegram', lainnya: '❓ Lainnya' };

    const alertMsg =
      `📨 <b>TIKET MANUAL BARU</b>\n\n` +
      `Ticket ID   : ${escapeHTML(ticketId)}\n` +
      `Tanggal     : ${escapeHTML(tanggal)}\n` +
      `Waktu Input : ${escapeHTML(waktu)} WIB\n` +
      `Diinput oleh: ${escapeHTML(session.senderName)}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `${severityEmoji} <b>Severity</b>    : ${escapeHTML(d.severity || 'medium')}\n` +
      `🗂 <b>Kategori</b>    : ${escapeHTML(d.category || '-')}\n` +
      `🖥 <b>Project</b>     : ${escapeHTML(d.project || '-')}\n` +
      `👤 <b>Pelapor</b>     : ${escapeHTML(d.requester || '-')}\n` +
      `📞 <b>Sumber</b>      : ${escapeHTML(sourceMap[d.source] || d.source || '-')}\n` +
      `⏰ <b>Waktu Kejadian</b>: ${escapeHTML(d.reported_time || '-')}\n` +
      `📌 <b>Issue Type</b>  : ${escapeHTML(d.issue_type || '-')}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      `📝 <b>Deskripsi:</b>\n${escapeHTML(d.description || session.rawText || '-')}`;

    // Kirim alert ke main group
    await sendIncidentAlert(emailObj, analysis, alertMsg);

    // Destroy session
    destroySession(chatId.toString(), userId);

    // Konfirmasi ke user
    await bot.sendMessage(chatId,
      `✅ <b>Tiket berhasil disimpan!</b>\n\n` +
      `📌 Ticket ID: <code>${ticketId}</code>\n` +
      `Alert telah dikirim ke main group.\n\n` +
      `Ketik /menu untuk kembali ke menu utama.`,
      { parse_mode: 'HTML' }
    );

  } catch (err) {
    console.error('❌ handleManualConfirm error:', err.message);
    destroySession(chatId.toString(), userId);
    await bot.sendMessage(chatId, '❌ Gagal menyimpan tiket. Silakan coba lagi dengan /tiket baru.');
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
  const summary = formatSessionSummary(session);

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Ya, Simpan Tiket', callback_data: 'manual_confirm' },
          { text: '❌ Batalkan', callback_data: 'manual_cancel' },
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, summary, { parse_mode: 'HTML', ...keyboard });
}

// ================== HELPER: RINGKASAN HASIL AI EXTRACTION ==================
function buildExtractionSummary(data, extracted) {
  const fields = [
    { key: 'description',   label: '📝 Deskripsi',   emoji: '' },
    { key: 'category',      label: '🗂 Kategori',     emoji: '' },
    { key: 'severity',      label: '🚦 Severity',     emoji: '' },
    { key: 'project',       label: '🖥 Project',      emoji: '' },
    { key: 'requester',     label: '👤 Pelapor',      emoji: '' },
    { key: 'source',        label: '📞 Sumber',       emoji: '' },
    { key: 'reported_time', label: '⏰ Waktu',         emoji: '' },
    { key: 'issue_type',    label: '📌 Issue Type',   emoji: '' },
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
    return `${title}\n\nTidak ada tiket ditemukan.`;
  }

  let text = `${title} (${tickets.length} tiket)\n\n`;

  tickets.slice(0, 15).forEach((ticket, index) => {
    const date = new Date(ticket.processed_at).toLocaleDateString('id-ID', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    const priorityEmoji = ticket.severity === 'emergency' ? '🔴' :
      ticket.severity === 'high' ? '🟠' : '🟡';

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
function escapeHTML(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ================== CREATE FORMAL TICKET ==================
function createFormalTicket(email, analysis = {}) {
  const now = email.created_at ? new Date(email.created_at) : (email.processed_at ? new Date(email.processed_at) : new Date());
  
  // Format tanggal: 1/7/2026
  const tanggal = now.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "numeric",
    year: "numeric"
  });
  
  // Format waktu: 14.37.12
  const waktu = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta"
  }).replace(/:/g, '.');

  const sourceMap = {
    email: "EMAIL",
    telegram_group: "TELEGRAM GROUP",
    whatsapp: "WHATSAPP"
  };
  const sourceLabel = sourceMap[email.source] || (email.source || "SYSTEM").toUpperCase();

  const statusMap = {
    Done: "✅ Resolved (Done)",
    Escalated: "🔄 Escalated",
    Cancelled: "❌ Cancelled",
    NoAction: "➖ No Action Needed",
    "In Progress": "In Progress"
  };
  const statusDisplay = statusMap[email.status] || email.status || "In Progress";

  const priority = (analysis.priority || email.priority || "MEDIUM").toUpperCase();
  const category = analysis.category || email.category || "Incident Management";
  const summary = analysis.summary || email.summary || "-";
  const ticketId = email.id || email.ticket_id;

  return `🚨 <b>PESAN BARU DARI ${sourceLabel}</b> 🚨

<b>Ticket ID</b>: ${escapeHTML(ticketId)}
<b>Received</b> : ${escapeHTML(tanggal)}, ${escapeHTML(waktu)} WIB

<b>From</b>     : ${escapeHTML(email.from)}

<b>Subject</b>  : ${escapeHTML(email.subject || email.group_name || '-')}

<b>Summary</b>  :
${escapeHTML(summary)}

<b>Content</b>:
${escapeHTML(email.body)}

<b>Priority</b> : ${escapeHTML(priority)}
<b>Category</b> : ${escapeHTML(category)}
<b>Status</b>   : ${escapeHTML(statusDisplay)}`;
}

// ================== SEND INCIDENT ALERT ==================
async function sendIncidentAlert(email, analysis = {}, customMessage = null) {
  const botInstance = initTelegramBot();
  const CHAT_ID = env.TG_CHAT_ID.trim();

  const activeAnalysis = analysis && Object.keys(analysis).length > 0 ? analysis : (email.analysis || {});
  const confidence = activeAnalysis.confidence_score !== undefined ? Number(activeAnalysis.confidence_score) : 100;
  const isPending = confidence < 80;

  let messageText = customMessage || email.formalMessage || createFormalTicket(email, activeAnalysis);

  if (isPending) {
    messageText = `⚠️ <b>BUTUH KONFIRMASI (Confidence: ${confidence}%)</b>\n\n` + messageText;
  }

  const severity = (activeAnalysis.severity || "medium").toLowerCase();
  const notifyLoud = ["emergency", "high"].includes(severity);

  let telegramMessageId = null;
  let telegramChatId = null;

  try {
    const keyboard = {
      reply_markup: {
        inline_keyboard: isPending ? [
          [
            { text: "✅ Approve (Confirm Ticket)", callback_data: "status_In Progress" },
            { text: "❌ Reject (No Action)", callback_data: "status_NoAction" }
          ]
        ] : [
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
      disable_notification: !notifyLoud && !isPending
    });

    telegramMessageId = sent.message_id.toString();
    telegramChatId = sent.chat.id.toString();
    console.log(`✅ Alert terkirim ke Telegram (message_id: ${telegramMessageId})`);
  } catch (err) {
    console.error("⚠️ Gagal mengirim notifikasi alert ke Telegram:", err.message);
  }

  // Simpan telegramChatId berformat "alertChatId|monitoredGroupId" agar bisa dilacak
  const dbTelegramChatId = email.group_id && telegramChatId 
    ? `${telegramChatId}|${email.group_id}` 
    : telegramChatId;

  // Tetap simpan ke Supabase meskipun Telegram gagal
  await saveEmailLog(
    email,
    activeAnalysis,
    telegramMessageId ? true : false,
    telegramMessageId,
    dbTelegramChatId
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
    await bot.editMessageText(cleanText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  }

  const statusMap = {
    Done: "✅ Resolved (Done)",
    Escalated: "🔄 Escalated",
    Cancelled: "❌ Cancelled",
    NoAction: "➖ No Action Needed"
  };
  const statusDisplay = statusMap[newStatus] || newStatus;

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
