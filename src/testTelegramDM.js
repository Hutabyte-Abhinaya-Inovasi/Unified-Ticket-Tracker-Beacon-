// src/testTelegramDM.js
// ─────────────────────────────────────────────────────────────────
// Script untuk mensimulasikan DM masuk ke Telegram Personal Account
// Digunakan untuk testing pipeline tanpa perlu akun Telegram kedua
//
// Jalankan: node src/testTelegramDM.js
// ─────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { saveRawTelegramDM } from './database/supabase.js';
import { extractTicketFields } from './infrastructure/ai/openaiService.js';
import { initTelegramBot, sendIncidentAlert } from './infrastructure/telegram/telegramService.js';

// ── Data simulasi DM customer ──
const DUMMY_MESSAGES = [
  {
    senderName: 'Budi Santoso',
    senderPhone: '+6281234567890',
    senderId: 'test_user_001',
    messageText: 'Halo, server SIMRS di gedung A tidak bisa diakses sejak jam 9 pagi tadi. Sudah dicoba restart tapi tetap tidak bisa. Mohon bantuannya segera karena berdampak ke seluruh poli.',
  },
  {
    senderName: 'Siti Rahma',
    senderPhone: '+6289876543210',
    senderId: 'test_user_002',
    messageText: 'Pak mau tanya, aplikasi absensi di PC saya error terus. Keluar tulisan "connection timeout" waktu mau login. Sudah dari kemarin begini.',
  },
  {
    senderName: 'Ahmad Fauzi',
    senderPhone: null,  // tanpa nomor HP (test edge case)
    senderId: 'test_user_003',
    messageText: 'Printer di ruang admin lantai 3 tidak bisa print. Sudah dicoba dari beberapa komputer tetap tidak bisa. Kertas tidak ada yang nyangkut.',
  },
];

async function runTest() {
  console.log('🧪 ====== TELEGRAM DM PIPELINE TEST ======');
  console.log('   Mensimulasikan DM masuk ke akun support\n');

  // Init bot dulu (untuk kirim alert ke grup)
  console.log('🤖 Menginisialisasi Telegram Bot...');
  initTelegramBot();
  await new Promise(r => setTimeout(r, 1500)); // tunggu bot siap

  // Pilih pesan yang akan ditest (index 0, 1, atau 2)
  const testIndex = parseInt(process.argv[2] || '0');
  const dm = DUMMY_MESSAGES[testIndex];

  if (!dm) {
    console.error(`❌ Index tidak valid. Gunakan: node src/testTelegramDM.js [0|1|2]`);
    process.exit(1);
  }

  console.log(`📩 Simulasi DM dari: ${dm.senderName}`);
  console.log(`   Pesan: ${dm.messageText.substring(0, 80)}...`);
  console.log('');

  const dmData = {
    messageId: `TEST-${Date.now()}`,
    senderName: dm.senderName,
    senderPhone: dm.senderPhone,
    senderId: dm.senderId,
    messageText: dm.messageText,
    timestamp: new Date().toISOString(),
    receiverPhone: '+6282285007971',
    receiverName: 'Samuel Sitio (TEST)',
  };

  // STEP 1: Simpan raw ke Supabase
  console.log('━━━ STEP 1: Simpan Raw Data ke Supabase ━━━');
  const rawData = await saveRawTelegramDM(dmData);
  if (!rawData) {
    console.error('❌ Gagal menyimpan ke Supabase!');
    process.exit(1);
  }
  console.log(`✅ Tersimpan! Ticket ID: ${rawData.ticket_id}\n`);

  // STEP 2: Proses AI
  console.log('━━━ STEP 2: Proses AI Extraction ━━━');
  let analysis = {};
  try {
    analysis = await extractTicketFields(dm.messageText);
    console.log('✅ Hasil AI:');
    console.log(`   Kategori  : ${analysis.category || '-'}`);
    console.log(`   Severity  : ${analysis.severity || '-'}`);
    console.log(`   Issue Type: ${analysis.issue_type || '-'}`);
    console.log(`   Project   : ${analysis.project || '-'}`);
    console.log(`   Pelapor   : ${analysis.requester || '-'}`);
    console.log('');
  } catch (err) {
    console.warn(`⚠️  AI gagal: ${err.message}`);
    console.log('   (Melanjutkan dengan data default)\n');
  }

  // STEP 3: Kirim alert ke grup Telegram
  console.log('━━━ STEP 3: Kirim Alert ke Grup Telegram ━━━');
  const emailObj = {
    id: rawData.ticket_id,
    ticket_id: rawData.ticket_id,
    from: dm.senderPhone ? `${dm.senderName} (${dm.senderPhone})` : dm.senderName,
    subject: `[TEST DM] Pesan dari ${dm.senderName}`,
    body: dm.messageText,
    source: 'telegram_personal',
    group_name: `[TEST] DM → Samuel Sitio (+6282285007971)`,
  };

  await sendIncidentAlert(emailObj, analysis);
  console.log('✅ Alert terkirim ke grup Telegram!\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ TEST SELESAI!');
  console.log('');
  console.log('Periksa:');
  console.log(`  1. Grup Telegram → tiket baru dengan ID ${rawData.ticket_id}`);
  console.log(`  2. Supabase → filter source = 'telegram_personal'`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ Test error:', err.message);
  console.error(err);
  process.exit(1);
});
