// src/infrastructure/telegram/slaWorker.js
// Cek tiket In Progress setiap 60 detik.
// Jika sudah melewati 50% atau 100% batas waktu SLA, kirim alarm ke grup UTT.

import TelegramBot from 'node-telegram-bot-api';
import { env } from '../../config/env.js';
import { getTicketsNeedingSlaCheck, markSlaFlag } from '../../database/supabase.js';

// Batas waktu SLA default per severity (dalam menit)
const SLA_MINUTES = {
  CRITICAL: 15,
  HIGH: 15,
  MEDIUM: 30,
  LOW: 120,
};

// Alarm dikirim saat elapsed >= 50% batas (warn) dan >= 100% batas (alert)
const WARN_RATIO = 0.5;
const ALERT_RATIO = 1.0;

let bot = null;

function getBot() {
  if (!bot) bot = new TelegramBot(env.TG_TOKEN, { polling: false });
  return bot;
}

async function checkSla() {
  const UTT_ID = (env.TG_UTT_CHAT_ID || env.TG_CHAT_ID).trim();
  const tickets = await getTicketsNeedingSlaCheck();

  for (const t of tickets) {
    const limitMin = t.sla_deadline_minutes || SLA_MINUTES[(t.priority || t.severity || 'MEDIUM').toUpperCase()] || 30;
    const elapsedMin = (Date.now() - new Date(t.confirmed_at).getTime()) / 60000;

    const reachedAlert = elapsedMin >= limitMin * ALERT_RATIO;
    const reachedWarn = elapsedMin >= limitMin * WARN_RATIO;

    if (!reachedWarn) continue;

    const level = reachedAlert ? 'alert' : 'warn';
    if (level === 'warn' && t.sla_warned) continue; // warn sudah terkirim

    const sisaMenit = Math.max(0, Math.round(limitMin - elapsedMin));
    const text =
      `ALARM SLA: TIKET BELUM DIKERJAKAN\n\n` +
      `Severity : ${(t.priority || t.severity || 'MEDIUM').toUpperCase()}\n` +
      `Ticket ID: ${t.ticket_id}\n` +
      `Sisa     : ${sisaMenit} menit lagi\n\n` +
      `Tiket ini belum dikerjakan sejak dikonfirmasi. Mohon segera ditangani.`;

    try {
      await getBot().sendMessage(UTT_ID, text);
      await markSlaFlag(t.ticket_id, level);
      console.log(`[SLA] Alarm [${level}] terkirim untuk tiket ${t.ticket_id}`);
    } catch (err) {
      console.error(`[SLA] Gagal kirim alarm tiket ${t.ticket_id}:`, err.message);
    }
  }
}

// Jalankan pengecekan setiap 60 detik
export function startSlaWorker() {
  console.log('SLA Worker aktif (interval 60 detik)');
  setInterval(() => checkSla().catch(err => console.error('[SLA] Error:', err.message)), 60_000);
  // Jalankan sekali langsung saat startup (opsional)
  checkSla().catch(() => { });
}
