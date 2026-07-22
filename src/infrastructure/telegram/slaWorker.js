// src/infrastructure/telegram/slaWorker.js
// Cek tiket setiap 60 detik.
// Alur SLA Beacon (dua looping):
//
// ── LOOPING 1: SLA KONFIRMASI (15 Menit) ──────────────────────────────────
//   → Tiket baru masuk (Pending Confirmation) → intake_received_at di-set
//   → WARN  : waktu tunggu >= 10 menit, belum dikonfirmasi → alarm ke Beacon
//   → ALERT : waktu tunggu >= 15 menit, belum dikonfirmasi → alarm URGENT ke Beacon
//
// ── LOOPING 2: SLA PEKERJAAN (2 Jam / sesuai severity) ───────────────────
//   → Tiket dikonfirmasi (In Progress) → confirmed_at di-set → timer berjalan
//   → WARN  : sisa waktu <= WARN_MINUTES_REMAINING (10 menit) → alarm ke Beacon
//   → ALERT : waktu habis (>= 100% limit) → INFORMASI URGENT ke Beacon + eskalasi

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import {
  getTicketsNeedingSlaCheck,
  getTicketsNeedingConfirmationCheck,
  markSlaFlag,
  markSlaConfirmFlag,
  updateTicket,
} from '../../database/supabase.js';

// ── LOOPING 2: Batas waktu SLA Pekerjaan per severity (dalam menit) ──────
const SLA_MINUTES = {
  CRITICAL: 15,
  HIGH:     15,
  MEDIUM:   30,
  LOW:      120,  // default 2 jam untuk tiket normal
};

// ── LOOPING 1: Batas waktu SLA Konfirmasi ────────────────────────────────
const SLA_CONFIRM_MINUTES      = 15;  // batas konfirmasi 15 menit
const SLA_CONFIRM_WARN_MINUTES = 5;   // warn saat sudah 5 menit belum dikonfirmasi (memberikan sisa 10 menit agar tidak mepet)

// Peringatan SLA Pekerjaan dikirim saat sisa waktu <= 10 menit
const WARN_MINUTES_REMAINING = 10;
// Alarm SLA Pekerjaan dikirim saat elapsed >= 100% batas waktu
const ALERT_RATIO = 1.0;

// Emoji severity
const SEVERITY_EMOJI = {
  CRITICAL:  '🔴',
  HIGH:      '🟠',
  MEDIUM:    '🟡',
  LOW:       '🟢',
  EMERGENCY: '🔴',
};

let bot = null;

function getBot() {
  if (!bot) bot = new TelegramBot(env.TG_TOKEN, { polling: false });
  return bot;
}

/**
 * Kirim notifikasi ke Head/Service Lead (jeremy & fahrezy) saat eskalasi SLA Pekerjaan.
 * Menggunakan env: TG_JEREMY_ID dan TG_FAHREZY_ID
 */
async function notifyHeadServiceLead(ticketId, severity, subject) {
  const leads = [
    env.TG_JEREMY_ID,
    env.TG_FAHREZY_ID,
  ].filter(Boolean); // hanya kirim ke ID yang sudah di-set di .env

  if (leads.length === 0) {
    console.warn('[SLA] Tidak ada TG_JEREMY_ID / TG_FAHREZY_ID di .env — notif head/lead dilewati.');
    return;
  }

  const sevEmoji = SEVERITY_EMOJI[(severity || 'MEDIUM').toUpperCase()] || '🟡';
  const msgToLead =
    `🆘 <b>ESKALASI OTOMATIS — SLA HABIS</b>\n\n` +
    `${sevEmoji} Severity : <b>${(severity || 'MEDIUM').toUpperCase()}</b>\n` +
    `🎫 Ticket ID : <code>${ticketId}</code>\n` +
    `📌 Subjek    : ${subject || '-'}\n\n` +
    `Tiket ini telah melewati batas waktu SLA dan belum dikerjakan.\n` +
    `<b>Mohon segera ditangani sebagai Head / Service Lead.</b>`;

  for (const leadId of leads) {
    try {
      await getBot().sendMessage(leadId.trim(), msgToLead, { parse_mode: 'HTML' });
      console.log(`[SLA] Notif eskalasi terkirim ke lead ${leadId}`);
    } catch (err) {
      console.error(`[SLA] Gagal kirim notif ke lead ${leadId}:`, err.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// LOOPING 1: SLA KONFIRMASI — cek tiket Pending Confirmation (15 Menit)
// ══════════════════════════════════════════════════════════════════
async function checkSlaConfirmation() {
  const BEACON_ID = (env.TG_BEACON_CHAT_ID || env.TG_CHAT_ID).trim();
  const tickets = await getTicketsNeedingConfirmationCheck();

  for (const t of tickets) {
    const elapsedMin = (Date.now() - new Date(t.intake_received_at).getTime()) / 60000;
    const sevEmoji   = SEVERITY_EMOJI[(t.priority || t.severity || 'MEDIUM').toUpperCase()] || '🟡';

    const reachedAlert = elapsedMin >= SLA_CONFIRM_MINUTES;
    const reachedWarn  = elapsedMin >= SLA_CONFIRM_WARN_MINUTES;

    // ── ALERT: 15 menit habis, belum dikonfirmasi ──────────────────────────
    if (reachedAlert) {
      if (t.sla_confirm_alerted) continue; // sudah pernah dikirim

      const alertText =
        `🚨 <b>SLA KONFIRMASI HABIS — TIKET BELUM DIKONFIRMASI!</b>\n\n` +
        `${sevEmoji} Severity  : <b>${(t.priority || t.severity || 'MEDIUM').toUpperCase()}</b>\n` +
        `🎫 Ticket ID : <code>${t.ticket_id}</code>\n` +
        `📌 Subjek    : ${t.subject || '-'}\n` +
        `⏱ Waktu tunggu: <b>${Math.round(elapsedMin)} menit</b> (batas: ${SLA_CONFIRM_MINUTES} menit)\n\n` +
        `⚠️ Tiket ini belum dikonfirmasi selama <b>${SLA_CONFIRM_MINUTES} menit</b>.\n` +
        `Silakan segera tentukan apakah ini tiket atau bukan.\n\n` +
        `<i>Cari tiket di grup dan tekan tombol [✅ Ini Tiket] atau [❌ Bukan Tiket].</i>`;

      try {
        await getBot().sendMessage(BEACON_ID, alertText, { parse_mode: 'HTML' });
        await markSlaConfirmFlag(t.ticket_id, 'alert');
        console.log(`[SLA-Konfirmasi] ALERT terkirim untuk tiket ${t.ticket_id} (${Math.round(elapsedMin)} menit belum dikonfirmasi)`);
      } catch (err) {
        console.error(`[SLA-Konfirmasi] Gagal kirim ALERT tiket ${t.ticket_id}:`, err.message);
      }
      continue;
    }

    // ── WARN: 10 menit, belum dikonfirmasi ──────────────────────────────────
    if (reachedWarn) {
      if (t.sla_confirm_warned) continue; // sudah pernah dikirim

      const sisaMin = Math.max(0, Math.round(SLA_CONFIRM_MINUTES - elapsedMin));
      const warnText =
        `⏰ <b>Peringatan SLA Konfirmasi — Sisa ${sisaMin} Menit!</b>\n\n` +
        `${sevEmoji} Severity  : <b>${(t.priority || t.severity || 'MEDIUM').toUpperCase()}</b>\n` +
        `🎫 Ticket ID : <code>${t.ticket_id}</code>\n` +
        `📌 Subjek    : ${t.subject || '-'}\n` +
        `⏳ Sudah menunggu: <b>${Math.round(elapsedMin)} menit</b>\n` +
        `⏱ Sisa konfirmasi: <b>${sisaMin} menit lagi</b>\n\n` +
        `Tiket ini belum dikonfirmasi. Mohon segera tentukan apakah ini tiket.`;

      try {
        await getBot().sendMessage(BEACON_ID, warnText, { parse_mode: 'HTML' });
        await markSlaConfirmFlag(t.ticket_id, 'warn');
        console.log(`[SLA-Konfirmasi] WARN terkirim untuk tiket ${t.ticket_id} (sisa ${sisaMin} menit)`);
      } catch (err) {
        console.error(`[SLA-Konfirmasi] Gagal kirim WARN tiket ${t.ticket_id}:`, err.message);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// LOOPING 2: SLA PEKERJAAN — cek tiket In Progress (2 Jam / per severity)
// ══════════════════════════════════════════════════════════════════
async function checkSla() {
  const BEACON_ID = (env.TG_BEACON_CHAT_ID || env.TG_CHAT_ID).trim();
  const tickets = await getTicketsNeedingSlaCheck();

  for (const t of tickets) {
    const severityKey = (t.priority || t.severity || 'MEDIUM').toUpperCase();
    const limitMin = t.sla_deadline_minutes || SLA_MINUTES[severityKey] || 120;
    const elapsedMin = (Date.now() - new Date(t.confirmed_at).getTime()) / 60000;
    const sisaMenit = Math.max(0, Math.round(limitMin - elapsedMin));
    const sevEmoji = SEVERITY_EMOJI[severityKey] || '🟡';

    const reachedAlert = elapsedMin >= limitMin * ALERT_RATIO;
    const reachedWarn  = sisaMenit <= WARN_MINUTES_REMAINING;

    // ── ALERT: waktu habis → INFORMASI URGENT + eskalasi ──────────────────
    if (reachedAlert) {
      if (t.sla_alerted) continue; // alert sudah terkirim sebelumnya

      const alertText =
        `🚨 <b>INFORMASI URGENT — SLA HABIS!</b>\n\n` +
        `${sevEmoji} Severity : <b>${severityKey}</b>\n` +
        `🎫 Ticket ID : <code>${t.ticket_id}</code>\n` +
        `📌 Subjek    : ${t.subject || '-'}\n` +
        `⏱ Waktu SLA : ${limitMin} menit (sudah habis)\n\n` +
        `⚠️ Tiket ini <b>BELUM dikerjakan</b> melebihi batas waktu SLA.\n` +
        `Sistem melakukan <b>eskalasi otomatis</b> ke Head / Service Lead.`;

      try {
        await getBot().sendMessage(BEACON_ID, alertText, { parse_mode: 'HTML' });
        await markSlaFlag(t.ticket_id, 'alert');

        // Eskalasi otomatis: update status ke Escalated di DB
        await updateTicket(t.ticket_id, {
          status: 'Escalated',
          escalated_at: new Date().toISOString(),
        });

        // Notifikasi ke Head/Service Lead (jeremy & fahrezy)
        await notifyHeadServiceLead(t.ticket_id, severityKey, t.subject);

        console.log(`[SLA] ALERT + Eskalasi otomatis untuk tiket ${t.ticket_id}`);
      } catch (err) {
        console.error(`[SLA] Gagal kirim ALERT tiket ${t.ticket_id}:`, err.message);
      }
      continue;
    }

    // ── WARN: sisa ≤ 10 menit → kirim alarm ke Beacon ──────────────────────
    if (reachedWarn) {
      if (t.sla_warned) continue; // warn sudah terkirim

      const warnText =
        `⚠️ <b>Beacon SLA — Waktunya ${sisaMenit} menit lagi!</b>\n\n` +
        `${sevEmoji} Severity : <b>${severityKey}</b>\n` +
        `🎫 Ticket ID : <code>${t.ticket_id}</code>\n` +
        `📌 Subjek    : ${t.subject || '-'}\n` +
        `⏱ Batas SLA : ${limitMin} menit\n` +
        `⏳ Sisa      : <b>${sisaMenit} menit lagi</b>\n\n` +
        `Tiket ini belum dikerjakan. Mohon segera ditangani sebelum SLA habis.`;

      try {
        await getBot().sendMessage(BEACON_ID, warnText, { parse_mode: 'HTML' });
        await markSlaFlag(t.ticket_id, 'warn');
        console.log(`[SLA] WARN terkirim untuk tiket ${t.ticket_id} (sisa ${sisaMenit} menit)`);
      } catch (err) {
        console.error(`[SLA] Gagal kirim WARN tiket ${t.ticket_id}:`, err.message);
      }
    }
  }
}

// Jalankan pengecekan setiap 60 detik (kedua looping)
export function startSlaWorker() {
  console.log('[SLA] SLA Worker aktif (interval 60 detik)');
  console.log(`[SLA] LOOPING 1 — SLA Konfirmasi: WARN >= ${SLA_CONFIRM_WARN_MINUTES} menit | ALERT >= ${SLA_CONFIRM_MINUTES} menit`);
  console.log(`[SLA] LOOPING 2 — SLA Pekerjaan : WARN sisa <= ${WARN_MINUTES_REMAINING} menit | ALERT saat waktu habis + Eskalasi`);

  setInterval(() => {
    checkSlaConfirmation().catch(err => console.error('[SLA-Konfirmasi] Error:', err.message));
    checkSla().catch(err => console.error('[SLA] Error:', err.message));
  }, 60_000);

  // Jalankan sekali langsung saat startup
  checkSlaConfirmation().catch(() => { });
  checkSla().catch(() => { });
}
