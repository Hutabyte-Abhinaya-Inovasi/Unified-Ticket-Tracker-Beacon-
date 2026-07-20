// src/infrastructure/telegram/slaWorker.js
// Cek tiket In Progress setiap 60 detik.
// Alur SLA Beacon (per diagram supervisor):
//   → Tiket dikonfirmasi → timer berjalan (default 15 menit untuk CRITICAL/HIGH)
//   → WARN  : sisa waktu <= WARN_MINUTES_REMAINING (10 menit) → kirim alarm ke Beacon
//   → ALERT : waktu habis (>= 100% limit)              → kirim INFORMASI URGENT ke Beacon
//   → ESCALATE: jika sudah ALERT → update status tiket ke Escalated + notif ke Head/Service Lead

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import { getTicketsNeedingSlaCheck, markSlaFlag, updateTicket } from '../../database/supabase.js';

// Batas waktu SLA default per severity (dalam menit)
const SLA_MINUTES = {
  CRITICAL: 15,
  HIGH: 15,
  MEDIUM: 30,
  LOW: 120,
};

// Alarm WARN dikirim saat sisa waktu <= 10 menit (bukan rasio, tapi menit tersisa)
const WARN_MINUTES_REMAINING = 10;
// Alarm ALERT dikirim saat elapsed >= 100% batas waktu
const ALERT_RATIO = 1.0;

// Emoji severity
const SEVERITY_EMOJI = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🟢',
};

let bot = null;

function getBot() {
  if (!bot) bot = new TelegramBot(env.TG_TOKEN, { polling: false });
  return bot;
}

/**
 * Kirim notifikasi ke Head/Service Lead (jeremy & fahrezy) saat eskalasi SLA.
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

async function checkSla() {
  const BEACON_ID = (env.TG_BEACON_CHAT_ID || env.TG_CHAT_ID).trim();
  const tickets = await getTicketsNeedingSlaCheck();

  for (const t of tickets) {
    const severityKey = (t.priority || t.severity || 'MEDIUM').toUpperCase();
    const limitMin = t.sla_deadline_minutes || SLA_MINUTES[severityKey] || 30;
    const elapsedMin = (Date.now() - new Date(t.confirmed_at).getTime()) / 60000;
    const sisaMenit = Math.max(0, Math.round(limitMin - elapsedMin));
    const sevEmoji = SEVERITY_EMOJI[severityKey] || '🟡';

    const reachedAlert = elapsedMin >= limitMin * ALERT_RATIO;
    const reachedWarn = sisaMenit <= WARN_MINUTES_REMAINING; // sisa <= 10 menit

    // ── ALERT: waktu habis → INFORMASI URGENT + eskalasi ──
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

    // ── WARN: sisa ≤ 10 menit → kirim alarm ke Beacon ──
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

// Jalankan pengecekan setiap 60 detik
export function startSlaWorker() {
  console.log('[SLA] SLA Worker aktif (interval 60 detik)');
  console.log(`[SLA] WARN saat sisa ≤ ${WARN_MINUTES_REMAINING} menit | ALERT + Eskalasi saat waktu habis`);
  setInterval(() => checkSla().catch(err => console.error('[SLA] Error:', err.message)), 60_000);
  // Jalankan sekali langsung saat startup
  checkSla().catch(() => { });
}
