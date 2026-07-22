// src/usecases/processRawMessage.js
//
// PROCESSOR UTAMA: Raw Intake → Deteksi Duplikat → Tiket
// ──────────────────────────────────────────────────────────
//
// Alur:
//   1. Cek small talk → ignored (cepat, tanpa AI)
//   2. Cek thread_ref → jika ada, langsung cari tiket via idempotency_ref
//   3. AI relevance check → ignored jika tidak relevan
//   4. Cari tiket aktif di source_ref yang sama (by group_id)
//   5. Jika ada tiket aktif:
//      a. AI: apakah pesan ini topik yang sama?
//      b. YA  → append ke tiket lama (status raw: 'threaded')
//              → AI deteksi status change (Done/Escalated/Cancelled)
//              → TIDAK ada notif Telegram baru (silent update)
//      c. TIDAK → anggap pesan baru, lanjut ke step 6
//   6. Tidak ada tiket terkait → buat tiket baru (status raw: 'processed')
//      → kirim notifikasi Telegram
//
// ──────────────────────────────────────────────────────────

import {
  isSmallTalk,
  analyzeEmail,
  checkMessageRelevance,
  routeMessageToActiveTickets,
  detectStatusChangeFromReply,
} from '../infrastructure/ai/openaiService.js';

import {
  markRawMessageAs,
  findActiveTicketsByGroupId,
  appendMessageToTicket,
  generateTicketId,
  supabase,
} from '../database/supabase.js';

import {
  sendIncidentAlert,
  updateIncidentStatusAndMessage,
} from '../infrastructure/telegram/telegramService.js';

import {
  pushTicketToClickUp,
} from '../infrastructure/clickup/clickupService.js';

import {
  updateTicket,
} from '../database/supabase.js';

// ─── Keyword heuristik untuk pesan balasan singkat ───────────────────────────
const REPLY_KEYWORDS = [
  "baik", "oke", "ok", "siap", "aman", "done", "proses",
  "sudah", "terima kasih", "thanks", "tolong", "yah", "ini",
  "tenggat", "kapan", "perbaiki", "selesai", "beres"
];

function isShortReply(text) {
  const t = text.toLowerCase().trim();
  return text.length < 25 && REPLY_KEYWORDS.some(k => t === k || t.startsWith(k + ' '));
}

// ─── Cari tiket aktif berdasarkan idempotency_key dari pesan yang di-quote ───
async function findTicketByIdempotencyRef(idempotencyRef) {
  if (!idempotencyRef) return null;
  try {
    const { data, error } = await supabase
      .from('intake_message')
      .select('ticket_id')
      .eq('idempotency_key', idempotencyRef)
      .not('ticket_id', 'is', null)
      .limit(1)
      .single();

    if (error || !data?.ticket_id) return null;

    // Ambil detail tiket untuk memastikan masih aktif
    const { data: ticket, error: ticketErr } = await supabase
      .from('Unified_Ticket_Tracker')
      .select('*')
      .eq('ticket_id', data.ticket_id)
      .single();

    if (ticketErr || !ticket) return null;
    if (['Done', 'Resolved', 'Cancelled', 'No Action'].includes(ticket.status)) {
      console.log(`   ⚠️  Tiket ${ticket.ticket_id} sudah ${ticket.status} — skip thread_ref`);
      return null;
    }

    return ticket;
  } catch (err) {
    console.error('❌ Gagal lookup tiket via thread_ref:', err.message);
    return null;
  }
}

// ─── Main processor ───────────────────────────────────────────────────────────

/**
 * Memproses satu pesan dari intake_message.
 *
 * Field yang digunakan dari rawMsg:
 * @param {string|number} rawMsg.id               - PK (null jika raw save gagal)
 * @param {string}        rawMsg.body_text         - Isi pesan
 * @param {string}        rawMsg.source_channel    - 'telegram' | 'wa_group' | 'wa_dm' | dst
 * @param {string}        rawMsg.source_ref        - ID grup/chat
 * @param {string}        rawMsg.sender            - "Nama (platform_id)"
 * @param {string}        [rawMsg.thread_ref]      - ID pesan yang di-quote (untuk threading langsung)
 * @param {Object}        [rawMsg.raw_payload]     - Payload lengkap (berisi group_name, dsb)
 * @param {string}        [rawMsg.idempotency_key] - Message ID platform
 * @param {string}        [rawMsg.received_at]     - Waktu pesan
 */
export async function processRawMessage(rawMsg) {
  const text          = rawMsg.body_text     || '';
  const sourceRef     = rawMsg.source_ref    || '';
  const sourceChannel = rawMsg.source_channel || 'wa_group';
  const senderName    = (rawMsg.sender || 'Unknown').split(' (')[0];  // ambil nama saja
  const groupName     = rawMsg.raw_payload?.group_name || sourceRef;


  console.log(`\n⚙️  [processRawMessage] id=${rawMsg.id} | channel=${sourceChannel} | group=${groupName} | dari=${senderName}`);
  console.log(`   Teks: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);


  // ── STEP 1: Small talk filter ─ DINONAKTIFKAN (semua pesan diproses) ──────
  // Semua pesan dari grup yang dimonitor akan diproses sebagai kandidat tiket.


  // ── STEP 2: Thread-ref lookup (langsung dari quote/reply WA) ─────────────
  // Jika pesan me-reply/quote pesan lain, cari tiket via idempotency_ref
  if (rawMsg.thread_ref) {
    console.log(`   🔗 thread_ref ditemukan: ${rawMsg.thread_ref} — mencari tiket induk...`);
    const parentByQuote = await findTicketByIdempotencyRef(rawMsg.thread_ref);

    if (parentByQuote) {
      console.log(`   💬 Direct threading via quote → tiket ${parentByQuote.ticket_id}`);
      await appendMessageToTicket(parentByQuote.ticket_id, parentByQuote.body, senderName, text);
      await markRawMessageAs(rawMsg.id, 'threaded', parentByQuote.ticket_id);

      // Deteksi perubahan status dari pesan balasan
      try {
        const detectedStatus = await detectStatusChangeFromReply(text);
        if (detectedStatus && detectedStatus !== 'no_change') {
          console.log(`   🔄 Status change terdeteksi → ${detectedStatus}`);
          await updateIncidentStatusAndMessage(parentByQuote.ticket_id, detectedStatus, true);
        }
      } catch (err) {
        console.warn(`   ⚠️  detectStatusChangeFromReply error: ${err.message}`);
      }

      return { action: 'threaded', ticketId: parentByQuote.ticket_id };
    }

    console.log(`   ↩️  thread_ref tidak cocok dengan tiket aktif — lanjut AI check`);
  }

  // ── STEP 3: AI analysis ─ untuk metadata tiket (summary, kategori, prioritas) ─
  // AI dijalankan untuk mengisi data tiket, tapi TIDAK memblokir pembuatan tiket.
  let analysis = {};
  try {
    analysis = await analyzeEmail({
      subject: groupName,
      body:    text,
      source:  sourceChannel,
    });
  } catch (err) {
    console.warn(`   ⚠️  AI analysis error: ${err.message} — fallback: default metadata`);
    analysis = { isRelevant: true, shouldProcess: true, confidence_score: 70 };
  }

  // Semua pesan tetap diproses walau AI menilai tidak relevan
  if (!analysis.isRelevant || !analysis.shouldProcess) {
    console.log(`   ℹ️  AI menilai kurang relevan (${analysis.reason || ''}) — tetap diproses sebagai kandidat tiket`);
    // Paksa confidence rendah agar tombol Approve/Reject tetap muncul
    analysis = { ...analysis, isRelevant: true, shouldProcess: true, confidence_score: 50 };
  }

  // ── STEP 4: Cari tiket aktif di grup/channel yang sama ───────────────────
  let activeTickets = [];
  if (sourceRef) {
    activeTickets = await findActiveTicketsByGroupId(sourceRef, sourceChannel);
  }

  // ── STEP 5: Deteksi apakah pesan ini lanjutan dari tiket yang ada ─────────
  if (activeTickets.length > 0) {
    let matchedTicket = null;

    if (isShortReply(text)) {
      // Heuristik cepat: balasan singkat → tiket paling baru
      matchedTicket = activeTickets[0];
      console.log(`   ⚡ Short reply → threading ke tiket terbaru: ${matchedTicket.ticket_id}`);
    } else if (activeTickets.length === 1) {
      // 1 tiket aktif → cek relevansi AI
      try {
        const isRelated = await checkMessageRelevance(
          text,
          activeTickets[0].body,
          activeTickets[0].summary
        );
        if (isRelated) matchedTicket = activeTickets[0];
      } catch (err) {
        console.warn(`   ⚠️  checkMessageRelevance error: ${err.message} — lanjut buat tiket baru`);
        // Jika AI gagal, tidak diasumsikan terkait → buat tiket baru
      }
    } else {
      // >1 tiket aktif → AI routing
      try {
        const matchedId = await routeMessageToActiveTickets(text, activeTickets);
        if (matchedId) {
          matchedTicket = activeTickets.find(t => t.ticket_id === matchedId) || null;
        }
      } catch (err) {
        console.warn(`   ⚠️  routeMessageToActiveTickets error: ${err.message} — lanjut buat tiket baru`);
        // Jika AI gagal, tidak diasumsikan ke tiket terbaru → buat tiket baru
      }
    }

    if (matchedTicket) {
      console.log(`   💬 Threading via AI → append ke tiket ${matchedTicket.ticket_id}`);

      await appendMessageToTicket(
        matchedTicket.ticket_id,
        matchedTicket.body,
        senderName,
        text
      );

      await markRawMessageAs(rawMsg.id, 'threaded', matchedTicket.ticket_id);

      // Deteksi perubahan status
      try {
        const detectedStatus = await detectStatusChangeFromReply(text);
        if (detectedStatus && detectedStatus !== 'no_change') {
          console.log(`   🔄 AI mendeteksi perubahan status → ${detectedStatus}`);
          await updateIncidentStatusAndMessage(matchedTicket.ticket_id, detectedStatus, true);
        }
      } catch (statusErr) {
        console.warn(`   ⚠️  detectStatusChangeFromReply error: ${statusErr.message}`);
      }

      // TIDAK kirim notif Telegram baru (silent update)
      return { action: 'threaded', ticketId: matchedTicket.ticket_id };
    }

    console.log(`   📋 Tidak ada tiket aktif yang cocok → buat tiket baru`);
  }

  // ── STEP 6: Buat tiket baru ────────────────────────────────────────────
  const ticketId = await generateTicketId();
  console.log(`   🆕 Membuat tiket baru: ${ticketId}`);

  const emailObj = {
    id:         ticketId,
    ticket_id:  ticketId,
    messageId:  rawMsg.idempotency_key || rawMsg.idempotency_ref,
    from:       senderName,
    subject:    groupName,
    body:       text,
    source:     sourceChannel,
    group_id:   sourceRef,
    group_name: groupName,
  };

  // Semua tiket baru masuk ke status "Pending Confirmation" — L1 harus approve
  // Confidence score sengaja disetel rendah (< 80) agar alert menampilkan tombol
  // [Approve] dan [Reject] bukan tombol status biasa.
  const pendingAnalysis = {
    ...analysis,
    confidence_score: analysis.confidence_score !== undefined
      ? Math.min(analysis.confidence_score, 79)  // paksa < 80 agar muncul tombol L1
      : 70,
  };

  // Kirim alert ke Telegram (dengan tombol Approve/Reject untuk L1)
  // → saveEmailLog dipanggil di dalam sendIncidentAlert
  await sendIncidentAlert(emailObj, pendingAnalysis);

  // Mark raw sebagai processed & link ke tiket baru
  // (ClickUp akan dipush setelah L1 approve via callback handleStatusChange)
  await markRawMessageAs(rawMsg.id, 'processed', ticketId);

  console.log(`   ✅ Tiket baru berhasil dibuat: ${ticketId} (menunggu konfirmasi L1)`);
  return { action: 'created', ticketId };
}

// ────────────────────────────────────────────────────────────────────
// HANDLER: L1 Approve → auto-push ke ClickUp
// Dipanggil dari telegramService.handleStatusChange saat L1 klik "Approve"
// ────────────────────────────────────────────────────────────────────

/**
 * Dipanggil setelah L1 mengklik "Approve" (Konfirmasi).
 * Mengubah status tiket dari "Pending Confirmation" ke "In Progress"
 * dan mengirim tiket ke ClickUp secara otomatis.
 *
 * @param {Object} ticket  - Row Unified_Ticket_Tracker yang baru saja diapprove
 */
export async function handleL1Approve(ticket) {
  console.log(`✅ [L1 Approve] Tiket ${ticket.ticket_id} dikonfirmasi, push ke ClickUp...`);

  try {
    const clickupResult = await pushTicketToClickUp(ticket);

    if (clickupResult) {
      // Simpan clickup_task_id dan clickup_url ke Supabase
      await updateTicket(ticket.ticket_id, {
        clickup_task_id: clickupResult.clickup_task_id,
        clickup_url:     clickupResult.clickup_url,
      });
      console.log(`📋 [ClickUp] Task berhasil: ${clickupResult.clickup_url}`);
    } else {
      console.warn(`⚠️  ClickUp push dilewati (API Key atau List ID belum dikonfigurasi).`);
    }
  } catch (err) {
    console.error(`❌ [L1 Approve] Gagal push ke ClickUp:`, err.message);
    // Tidak throw — L1 approve tetap berlaku walau ClickUp gagal
  }
}
