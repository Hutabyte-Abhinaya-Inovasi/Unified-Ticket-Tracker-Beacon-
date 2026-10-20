// src/infrastructure/telegram/slaWorker.js
// Cek tiket setiap 60 detik.
// Alur SLA Beacon (dua looping):
//
// ── LOOPING 1: SLA KONFIRMASI (15 Menit) ──────────────────────────────────
//   → Tiket baru masuk → intake_received_at di-set
//   → Pengecekan berlaku untuk semua status kecuali Done
//   → WARN  : sisa waktu <= 10 menit (mulai sekitar menit ke-5), belum dikonfirmasi
//   → ALERT : waktu tunggu >= 15 menit, belum dikonfirmasi → alarm URGENT ke Beacon
//
// ── LOOPING 2: SLA PEKERJAAN (2 Jam / sesuai severity) ───────────────────
//   → Tiket dikonfirmasi (In Progress) → confirmed_at di-set → timer berjalan
//   → WARN  : sisa waktu <= WARN_MINUTES_REMAINING (10 menit) → alarm ke Beacon
//   → ALERT : waktu habis (>= 100% limit) → INFORMASI URGENT ke Beacon + eskalasi

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import { sendTeamsSlaAlert } from '../teams/teamsService.js';
import {
  getTicketsNeedingSlaCheck,
  getTicketsNeedingConfirmationCheck,
  getPendingIntakesNeedingConfirmationCheck,
  markSlaFlag,
  markSlaConfirmFlag,
  markIntakeSlaConfirmFlag,
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
const SLA_CONFIRM_MINUTES = 15; // batas konfirmasi 15 menit
const SLA_CONFIRM_WARN_REMAINING_MINUTES = 10; // peringatan saat sisa waktu 10 menit
const SLA_CONFIRM_WARN_REPEAT_MINUTES = 5; // kirim ulang peringatan setiap 5 menit

// Peringatan SLA Pekerjaan dikirim saat sisa waktu <= 6 menit
const WARN_MINUTES_REMAINING = 6;
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

function escapeTelegramHtml(value = '-') {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    `${sevEmoji} Severity : <b>${escapeTelegramHtml((severity || 'MEDIUM').toUpperCase())}</b>\n` +
    `🎫 Ticket ID : <code>${escapeTelegramHtml(ticketId)}</code>\n` +
    `📌 Subjek    : ${escapeTelegramHtml(subject)}\n\n` +
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
  // Semua peringatan & alert SLA ditujukan ke grup Beacon SLA & Escalation (Merah)
  const ALERT_CHAT_ID = (env.TG_BEACON_CHAT_ID || env.TG_CHAT_ID || '-1003753882093').trim();
  const tickets = await getTicketsNeedingConfirmationCheck();
  console.log(`[SLA-Konfirmasi] Memeriksa ${tickets.length} tiket non-Done (chat ${ALERT_CHAT_ID})`);

  for (const t of tickets) {
    if (t.sla_confirm_alerted) continue;

    const startedAt = t.intake_received_at || t.confirmed_at || t.processed_at || t.created_at;
    const startedAtMs = new Date(startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) {
      console.warn(`[SLA-Konfirmasi] Timestamp awal tidak valid untuk tiket ${t.ticket_id}; tiket dilewati.`);
      continue;
    }

    const elapsedMin = (Date.now() - startedAtMs) / 60000;
    const sevEmoji   = SEVERITY_EMOJI[(t.priority || t.severity || 'MEDIUM').toUpperCase()] || '🟡';

    const reachedAlert = elapsedMin >= SLA_CONFIRM_MINUTES;
    const reachedWarn  = elapsedMin >= SLA_CONFIRM_MINUTES - SLA_CONFIRM_WARN_REMAINING_MINUTES;

    // ── ALERT: 15 menit habis, belum dikonfirmasi ──────────────────────────
    if (reachedAlert) {
      if (t.sla_confirm_alerted) continue; // sudah pernah dikirim

      const alertText =
        `🚨 <b>SLA KONFIRMASI HABIS — TIKET BELUM DIKONFIRMASI!</b>\n\n` +
        `${sevEmoji} Severity  : <b>${escapeTelegramHtml((t.priority || t.severity || 'MEDIUM').toUpperCase())}</b>\n` +
        `🎫 Ticket ID : <code>${escapeTelegramHtml(t.ticket_id)}</code>\n` +
        `📌 Subjek    : ${escapeTelegramHtml(t.subject)}\n` +
        `⏱ Waktu tunggu: <b>${Math.round(elapsedMin)} menit</b> (batas: ${SLA_CONFIRM_MINUTES} menit)\n\n` +
        `⚠️ Tiket ini belum dikonfirmasi di Ticket Operations selama <b>${SLA_CONFIRM_MINUTES} menit</b>.\n` +
        `<i>Mohon segera pantau dan tindak lanjuti pada grup Ticket Operations.</i>`;

      try {
        await getBot().sendMessage(ALERT_CHAT_ID, alertText, { parse_mode: 'HTML' });
        await markSlaConfirmFlag(t.ticket_id, 'alert');
        console.log(`[SLA-Konfirmasi] ALERT terkirim ke Beacon SLA untuk tiket ${t.ticket_id} (${Math.round(elapsedMin)} menit belum dikonfirmasi)`);

        // Kirim juga ke Microsoft Teams
        sendTeamsSlaAlert({
          type: 'confirm_alert',
          ticketId: t.ticket_id,
          severity: t.priority || t.severity,
          subject: t.subject,
          elapsedMin: elapsedMin,
        }).catch(err => console.error('[SLA-Teams] Gagal kirim confirm alert:', err.message));
      } catch (err) {
        console.error(`[SLA-Konfirmasi] Gagal kirim ALERT tiket ${t.ticket_id}:`, err.message);
      }
      continue;
    }

    // ── WARN: sisa <= 10 menit, ulang setiap 5 menit ──────────────────────
    if (reachedWarn) {
      const lastWarnedAt = t.sla_confirm_last_warned_at
        ? new Date(t.sla_confirm_last_warned_at).getTime()
        : null;
      const warnIntervalElapsed = !Number.isFinite(lastWarnedAt) ||
        Date.now() - lastWarnedAt >= SLA_CONFIRM_WARN_REPEAT_MINUTES * 60_000;
      if (!warnIntervalElapsed) continue;

      const sisaMin = Math.max(0, Math.round(SLA_CONFIRM_MINUTES - elapsedMin));
      const warnText =
        `🔔 <b>ALERT — Sisa waktu Confirmation tinggal ${sisaMin} menit!</b>\n\n` +
        `${sevEmoji} Severity  : <b>${escapeTelegramHtml((t.priority || t.severity || 'MEDIUM').toUpperCase())}</b>\n` +
        `🎫 Ticket ID : <code>${escapeTelegramHtml(t.ticket_id)}</code>\n` +
        `📌 Subjek    : ${escapeTelegramHtml(t.subject)}\n` +
        `⏳ Sudah menunggu: <b>${Math.round(elapsedMin)} menit</b>\n` +
        `⏱ Sisa konfirmasi: <b>${sisaMin} menit lagi</b>\n\n` +
        `⚠️ Tiket ini belum dikonfirmasi di Ticket Operations.`;

      try {
        await getBot().sendMessage(ALERT_CHAT_ID, warnText, { parse_mode: 'HTML' });
        await markSlaConfirmFlag(t.ticket_id, 'warn');
        console.log(`[SLA-Konfirmasi] WARN terkirim ke Beacon SLA untuk tiket ${t.ticket_id} (sisa ${sisaMin} menit)`);

        // Kirim juga ke Microsoft Teams
        sendTeamsSlaAlert({
          type: 'confirm_warn',
          ticketId: t.ticket_id,
          severity: t.priority || t.severity,
          subject: t.subject,
          elapsedMin: elapsedMin,
          sisaMenit: sisaMin,
        }).catch(err => console.error('[SLA-Teams] Gagal kirim confirm warn:', err.message));
      } catch (err) {
        console.error(`[SLA-Konfirmasi] Gagal kirim WARN tiket ${t.ticket_id}:`, err.message);
      }
    }
  }

  // ── Pemeriksaan intake mentah (intake_message) yang masih berstatus pending ──
  const pendingIntakes = await getPendingIntakesNeedingConfirmationCheck();
  if (pendingIntakes.length > 0) {
    console.log(`[SLA-Konfirmasi] Memeriksa ${pendingIntakes.length} intake pending`);
  }

  for (const intake of pendingIntakes) {
    const rawPayload = intake.raw_payload || {};
    if (rawPayload.sla_confirm_alerted) continue;

    const startedAt = intake.received_at;
    const startedAtMs = new Date(startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) continue;

    const elapsedMin = (Date.now() - startedAtMs) / 60000;
    const mentions = rawPayload.mentions || [];
    const hasMentions = mentions.length > 0;
    const severity = hasMentions ? 'HIGH' : 'MEDIUM';
    const sevEmoji = SEVERITY_EMOJI[severity] || '🟡';
    const subject = rawPayload.subject || '(No Subject)';
    const taggedStr = hasMentions
      ? `\n🏷️ Tagged PIC : ${mentions.map((m) => `@${m.name}`).join(', ')}`
      : '';

    const reachedAlert = elapsedMin >= SLA_CONFIRM_MINUTES;
    const reachedWarn = elapsedMin >= SLA_CONFIRM_MINUTES - SLA_CONFIRM_WARN_REMAINING_MINUTES;

    if (reachedAlert) {
      const alertText =
        `🚨 <b>SLA KONFIRMASI HABIS — KANDIDAT TIKET BELUM DIKONFIRMASI!</b>\n\n` +
        `${sevEmoji} Severity  : <b>${severity}</b>\n` +
        `🆔 Intake ID  : <code>${intake.id}</code>\n` +
        `👤 Pengirim   : ${escapeTelegramHtml(intake.sender)}\n` +
        `📌 Subjek     : ${escapeTelegramHtml(subject)}${taggedStr}\n` +
        `⏱ Waktu tunggu: <b>${Math.round(elapsedMin)} menit</b> (batas: ${SLA_CONFIRM_MINUTES} menit)\n\n` +
        `⚠️ Kandidat tiket ini belum dikonfirmasi di Ticket Operations selama <b>${SLA_CONFIRM_MINUTES} menit</b>.\n` +
        `<i>Mohon segera pantau dan tindak lanjuti pada grup Ticket Operations.</i>`;

      try {
        await getBot().sendMessage(ALERT_CHAT_ID, alertText, { parse_mode: 'HTML' });
        await markIntakeSlaConfirmFlag(intake.id, 'alert');
        console.log(`[SLA-Konfirmasi] ALERT terkirim untuk Intake ${intake.id} (${Math.round(elapsedMin)} menit)`);

        sendTeamsSlaAlert({
          type: 'confirm_alert',
          ticketId: `Intake #${intake.id}`,
          severity: severity,
          subject: subject,
          elapsedMin: elapsedMin,
        }).catch((err) => console.error('[SLA-Teams] Gagal kirim confirm alert:', err.message));
      } catch (err) {
        console.error(`[SLA-Konfirmasi] Gagal kirim ALERT intake ${intake.id}:`, err.message);
      }
      continue;
    }

    if (reachedWarn) {
      const lastWarnedAt = rawPayload.sla_confirm_last_warned_at
        ? new Date(rawPayload.sla_confirm_last_warned_at).getTime()
        : null;
      const warnIntervalElapsed =
        !Number.isFinite(lastWarnedAt) ||
        Date.now() - lastWarnedAt >= SLA_CONFIRM_WARN_REPEAT_MINUTES * 60_000;
      if (!warnIntervalElapsed) continue;

      const sisaMin = Math.max(0, Math.round(SLA_CONFIRM_MINUTES - elapsedMin));
      const warnText =
        `🔔 <b>ALERT — Sisa waktu Confirmation Intake tinggal ${sisaMin} menit!</b>\n\n` +
        `${sevEmoji} Severity  : <b>${severity}</b>\n` +
        `🆔 Intake ID  : <code>${intake.id}</code>\n` +
        `👤 Pengirim   : ${escapeTelegramHtml(intake.sender)}\n` +
        `📌 Subjek     : ${escapeTelegramHtml(subject)}${taggedStr}\n` +
        `⏳ Sudah menunggu: <b>${Math.round(elapsedMin)} menit</b>\n` +
        `⏱ Sisa konfirmasi: <b>${sisaMin} menit lagi</b>\n\n` +
        `⚠️ Kandidat tiket belum dikonfirmasi di Ticket Operations.`;

      try {
        await getBot().sendMessage(ALERT_CHAT_ID, warnText, { parse_mode: 'HTML' });
        await markIntakeSlaConfirmFlag(intake.id, 'warn');
        console.log(`[SLA-Konfirmasi] WARN terkirim untuk Intake ${intake.id} (sisa ${sisaMin} menit)`);

        sendTeamsSlaAlert({
          type: 'confirm_warn',
          ticketId: `Intake #${intake.id}`,
          severity: severity,
          subject: subject,
          elapsedMin: elapsedMin,
          sisaMenit: sisaMin,
        }).catch((err) => console.error('[SLA-Teams] Gagal kirim confirm warn:', err.message));
      } catch (err) {
        console.error(`[SLA-Konfirmasi] Gagal kirim WARN intake ${intake.id}:`, err.message);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// LOOPING 2: SLA PEKERJAAN — cek tiket In Progress (2 Jam / per severity)
// ══════════════════════════════════════════════════════════════════
async function checkSla() {
  // Alert SLA Pekerjaan & Eskalasi ditujukan ke Beacon SLA & Escalation (Merah)
  const SLA_CHAT_ID = (env.TG_BEACON_CHAT_ID || env.TG_CHAT_ID || '-1003753882093').trim();
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
        `${sevEmoji} Severity : <b>${escapeTelegramHtml(severityKey)}</b>\n` +
        `🎫 Ticket ID : <code>${escapeTelegramHtml(t.ticket_id)}</code>\n` +
        `📌 Subjek    : ${escapeTelegramHtml(t.subject)}\n` +
        `⏱ Waktu SLA : ${limitMin} menit (sudah habis)\n\n` +
        `⚠️ Tiket ini <b>BELUM dikerjakan</b> melebihi batas waktu SLA.\n` +
        `Sistem melakukan <b>eskalasi otomatis</b> ke Head / Service Lead.`;

      try {
        await getBot().sendMessage(SLA_CHAT_ID, alertText, { parse_mode: 'HTML' });
        await markSlaFlag(t.ticket_id, 'alert');

        // Eskalasi otomatis: update status ke Escalated di DB
        await updateTicket(t.ticket_id, {
          status: 'Escalated',
          escalated_at: new Date().toISOString(),
        });

        // Notifikasi ke Head/Service Lead (jeremy & fahrezy)
        await notifyHeadServiceLead(t.ticket_id, severityKey, t.subject);

        // Kirim juga ke Microsoft Teams
        sendTeamsSlaAlert({
          type: 'work_alert',
          ticketId: t.ticket_id,
          severity: severityKey,
          subject: t.subject,
          limitMin: limitMin,
        }).catch(err => console.error('[SLA-Teams] Gagal kirim work alert:', err.message));

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
        `${sevEmoji} Severity : <b>${escapeTelegramHtml(severityKey)}</b>\n` +
        `🎫 Ticket ID : <code>${escapeTelegramHtml(t.ticket_id)}</code>\n` +
        `📌 Subjek    : ${escapeTelegramHtml(t.subject)}\n` +
        `⏱ Batas SLA : ${limitMin} menit\n` +
        `⏳ Sisa      : <b>${sisaMenit} menit lagi</b>\n\n` +
        `Tiket ini belum dikerjakan. Mohon segera ditangani sebelum SLA habis.`;

      try {
        await getBot().sendMessage(SLA_CHAT_ID, warnText, { parse_mode: 'HTML' });
        await markSlaFlag(t.ticket_id, 'warn');
        console.log(`[SLA] WARN terkirim untuk tiket ${t.ticket_id} (sisa ${sisaMenit} menit)`);

        // Kirim juga ke Microsoft Teams
        sendTeamsSlaAlert({
          type: 'work_warn',
          ticketId: t.ticket_id,
          severity: severityKey,
          subject: t.subject,
          limitMin: limitMin,
          sisaMenit: sisaMenit,
        }).catch(err => console.error('[SLA-Teams] Gagal kirim work warn:', err.message));
      } catch (err) {
        console.error(`[SLA] Gagal kirim WARN tiket ${t.ticket_id}:`, err.message);
      }
    }
  }
}

// Jalankan pengecekan setiap 60 detik (kedua looping)
export function startSlaWorker() {
  console.log('[SLA] SLA Worker aktif (interval 60 detik)');
  console.log(`[SLA] LOOPING 1 — SLA Konfirmasi: WARN saat sisa <= ${SLA_CONFIRM_WARN_REMAINING_MINUTES} menit, ulang tiap ${SLA_CONFIRM_WARN_REPEAT_MINUTES} menit | ALERT >= ${SLA_CONFIRM_MINUTES} menit`);
  console.log(`[SLA] LOOPING 2 — SLA Pekerjaan : WARN sisa <= ${WARN_MINUTES_REMAINING} menit | ALERT saat waktu habis + Eskalasi`);

  setInterval(() => {
    checkSlaConfirmation().catch(err => console.error('[SLA-Konfirmasi] Error:', err.message));
    checkSla().catch(err => console.error('[SLA] Error:', err.message));
  }, 60_000);

  // Jalankan sekali langsung saat startup
  checkSlaConfirmation().catch(err => console.error('[SLA-Konfirmasi] Error saat startup:', err.message));
  checkSla().catch(err => console.error('[SLA] Error saat startup:', err.message));
}
