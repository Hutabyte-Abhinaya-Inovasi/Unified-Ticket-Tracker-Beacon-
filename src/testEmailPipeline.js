// src/testEmailPipeline.js
// ─────────────────────────────────────────────────────────────────
// Script pengujian manual: simulasi email masuk ke sistem
// Melewati pipeline lengkap: AI Analysis → Telegram Alert → Supabase
//
// Cara jalankan (terminal baru, BUKAN yang sedang npm start):
//   node src/testEmailPipeline.js 0   → Skenario 1: WiFi Mati
//   node src/testEmailPipeline.js 1   → Skenario 2: Server Down
//   node src/testEmailPipeline.js 2   → Skenario 3: Request Akses
// ─────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { analyzeEmail } from './infrastructure/ai/openaiService.js';
import { initTelegramBot, sendIncidentAlert } from './infrastructure/telegram/telegramService.js';
import { generateTicketId } from './database/supabase.js';

// ── Skenario Email Dummy ──────────────────────────────────────────
const SKENARIO_EMAIL = [
  {
    label: 'SKENARIO 1 — Incident: WiFi Mati di Gedung 7',
    from: 'jeremi.pratama@hutabyte.com',
    subject: 'Wifi mati dari jam 8 di Gedung 7',
    body: `Selamat pagi Tim IT,

Saya ingin melaporkan bahwa koneksi WiFi di Gedung 7 tidak dapat digunakan sejak pukul 08.00 WIB pagi ini.

Sudah saya coba dari beberapa perangkat (laptop dan HP) namun semua tidak bisa terkoneksi. 
Pengguna di lantai 2 dan lantai 3 juga mengalami hal yang sama.

Mohon segera ditangani karena berdampak ke aktivitas kerja.

Terima kasih,
Jeremi Pratama
Staff Operasional - Gedung 7`,
  },
  {
    label: 'SKENARIO 2 — Incident Critical: Server SIMRS Down',
    from: 'fahrezy.admin@hutabyte.com',
    subject: '[CRITICAL] Server SIMRS tidak bisa diakses sejak pukul 07.30',
    body: `Dear Tim IT,

Server SIMRS (Sistem Informasi Manajemen Rumah Sakit) tidak dapat diakses sama sekali sejak pukul 07.30 WIB.

Dampak:
- Seluruh poli rawat jalan tidak bisa input data pasien
- Apotek tidak bisa cetak resep
- Kasir tidak bisa proses pembayaran

Ini sangat URGENT karena sudah ada antrian pasien yang menumpuk.

Mohon eskalasi segera ke tim terkait.

Fahrezy Hamdani
Supervisor IT - RSUD Hutabyte`,
  },
  {
    label: 'SKENARIO 3 — Service Request: Minta Akses Aplikasi',
    from: 'samuel.janring@hutabyte.com',
    subject: 'Permohonan Akses Aplikasi ClickUp untuk Tim Baru',
    body: `Halo Tim IT,

Saya Samuel dari Tim Project Management.
Kami memiliki 3 anggota tim baru yang bergabung minggu ini dan membutuhkan akses ke aplikasi ClickUp.

Nama anggota:
1. Budi Santoso (budi.santoso@hutabyte.com)
2. Siti Rahma (siti.rahma@hutabyte.com)
3. Ahmad Fauzi (ahmad.fauzi@hutabyte.com)

Mohon dibuatkan akun dengan role Member.
Tidak terlalu urgent, bisa dikerjakan dalam 1-2 hari ke depan.

Terima kasih,
Samuel Janring Sitio
Project Manager`,
  },
];

// ─────────────────────────────────────────────────────────────────
async function runEmailTest() {
  const idx = parseInt(process.argv[2] ?? '0');
  const skenario = SKENARIO_EMAIL[idx];

  if (!skenario) {
    console.error(`\u274c Index tidak valid. Gunakan: node src/testEmailPipeline.js [0|1|2]`);
    process.exit(1);
  }

  console.log('\n\ud83e\uddea \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(`   EMAIL PIPELINE TEST \u2014 ${skenario.label}`);
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
  console.log(`\ud83d\udce7 From    : ${skenario.from}`);
  console.log(`\ud83d\udccc Subject : ${skenario.subject}`);
  console.log(`\ud83d\udcdd Body    : ${skenario.body.substring(0, 80)}...`);
  console.log('');

  // STEP 1: Init Bot
  console.log('STEP 1 \u2500\u2500 Init Telegram Bot...');
  initTelegramBot();
  await new Promise(r => setTimeout(r, 1500));
  console.log('\u2705 Bot siap\n');

  // STEP 2: Generate Ticket ID
  console.log('STEP 2 \u2500\u2500 Generate Ticket ID...');
  const ticketId = await generateTicketId();
  console.log(`\u2705 Ticket ID: ${ticketId}\n`);

  // STEP 3: AI Analysis
  console.log('STEP 3 \u2500\u2500 Analisis AI (analyzeEmail)...');
  let analysis = { isRelevant: true, shouldProcess: true, confidence_score: 70 };
  try {
    analysis = await analyzeEmail({
      subject: skenario.subject,
      body:    skenario.body,
      source:  'email',
    });
    console.log('\u2705 Hasil AI:');
    console.log(`   isRelevant       : ${analysis.isRelevant}`);
    console.log(`   confidence_score : ${analysis.confidence_score}`);
    console.log(`   category         : ${analysis.category}`);
    console.log(`   severity/priority: ${analysis.severity || analysis.priority}`);
    console.log(`   summary          : ${(analysis.summary || '-').substring(0, 100)}`);
  } catch (err) {
    console.warn(`\u26a0\ufe0f  AI gagal (${err.message}) \u2014 menggunakan fallback analysis`);
  }

  // Paksa confidence < 80 agar muncul sebagai Pending Confirmation dengan tombol
  const pendingAnalysis = {
    ...analysis,
    confidence_score: Math.min(analysis.confidence_score ?? 70, 79),
  };
  console.log(`\n   \u2192 confidence disetel ke ${pendingAnalysis.confidence_score} (status: Pending Confirmation)\n`);

  // STEP 4: Kirim Alert ke Telegram
  console.log('STEP 4 \u2500\u2500 Kirim KANDIDAT TIKET ke Telegram Beacon...');
  const emailObj = {
    id:         ticketId,
    ticket_id:  ticketId,
    messageId:  `TEST-EMAIL-${Date.now()}`,
    from:       skenario.from,
    subject:    skenario.subject,
    body:       skenario.body,
    source:     'email',
    group_id:   null,
    group_name: 'Email - Test Pipeline',
  };

  try {
    await sendIncidentAlert(emailObj, pendingAnalysis);
    console.log('\u2705 Notifikasi KANDIDAT TIKET berhasil dikirim ke Beacon!\n');
  } catch (err) {
    console.error('\u274c Gagal kirim ke Telegram:', err.message);
    process.exit(1);
  }

  // RINGKASAN
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('\u2705  TEST SELESAI! Yang harus diverifikasi:\n');
  console.log(`  [1] Buka grup Telegram Beacon:`);
  console.log(`      \u2192 Cari pesan "\ud83d\udce5 KANDIDAT TIKET BARU"`);
  console.log(`      \u2192 Pastikan Intake ID: ${ticketId}`);
  console.log(`      \u2192 Pastikan ada [ \u2705 Ini Tiket ] dan [ \u274c Bukan Tiket ]`);
  console.log(`      \u2192 Status = "Menunggu Konfirmasi (SLA: 15 Menit)"\n`);
  console.log(`  [2] Supabase \u2192 Unified_Ticket_Tracker:`);
  console.log(`      \u2192 Filter ticket_id = '${ticketId}'`);
  console.log(`      \u2192 intake_received_at harus terisi timestamp`);
  console.log(`      \u2192 status = 'Pending Confirmation'\n`);
  console.log(`  [3] Klik [ \u2705 Ini Tiket ] \u2192 harus muncul pesan "SLA Pekerjaan 2 Jam Dimulai"`);
  console.log(`  [4] Test skenario baru \u2192 klik [ \u274c Bukan Tiket ] \u2192 harus muncul double-check`);
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');

  process.exit(0);
}

runEmailTest().catch(err => {
  console.error('\u274c Test error:', err.message);
  console.error(err);
  process.exit(1);
});
