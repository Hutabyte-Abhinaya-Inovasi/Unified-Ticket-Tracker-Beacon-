// src/uploadAuthToSupabase.js
// Script sekali jalan untuk upload session WhatsApp lokal ke Supabase
// Jalankan dengan: node src/uploadAuthToSupabase.js

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Polyfill WebSocket untuk Node.js 20 agar Supabase bisa jalan
globalThis.WebSocket = WebSocket;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AUTH_FOLDER = './auth_info';
const SESSION_ID = 'whatsapp-session';

async function uploadAuthToSupabase() {
  if (!existsSync(AUTH_FOLDER)) {
    console.error('❌ Folder auth_info tidak ditemukan!');
    process.exit(1);
  }

  const files = readdirSync(AUTH_FOLDER);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  if (jsonFiles.length === 0) {
    console.error('❌ Tidak ada file session (.json) di folder auth_info!');
    process.exit(1);
  }

  console.log(`\n📤 Mengupload ${jsonFiles.length} file session WhatsApp ke Supabase...`);
  console.log(`   Session ID: ${SESSION_ID}`);
  console.log('=' .repeat(60));

  let successCount = 0;
  let failCount = 0;

  for (const file of jsonFiles) {
    const keyId = file.replace('.json', '');
    const filePath = join(AUTH_FOLDER, file);
    
    try {
      const rawContent = readFileSync(filePath, 'utf8');
      // Validasi JSON dulu
      JSON.parse(rawContent);

      const { error } = await supabase
        .from('whatsapp_auth')
        .upsert({
          session_id: SESSION_ID,
          key_id: keyId,
          value: rawContent,
        }, { onConflict: 'session_id,key_id' });

      if (error) {
        console.error(`❌ Gagal upload: ${keyId} →`, error.message);
        failCount++;
      } else {
        console.log(`✅ ${keyId}`);
        successCount++;
      }
    } catch (err) {
      console.error(`❌ Error pada file ${file}:`, err.message);
      failCount++;
    }
  }

  console.log('=' .repeat(60));
  console.log(`\n📊 Hasil Upload:`);
  console.log(`   ✅ Berhasil : ${successCount} file`);
  console.log(`   ❌ Gagal    : ${failCount} file`);

  if (successCount > 0 && failCount === 0) {
    console.log(`\n🎉 Semua session berhasil diupload ke Supabase!`);
    console.log(`\n📋 LANGKAH SELANJUTNYA:`);
    console.log(`   1. Tambahkan variabel ini di Railway:`);
    console.log(`      USE_SUPABASE_AUTH=true`);
    console.log(`   2. Deploy ke Railway — WhatsApp tidak akan minta scan QR lagi!`);
  } else if (failCount > 0) {
    console.log(`\n⚠️  Ada beberapa file yang gagal. Pastikan tabel whatsapp_auth sudah dibuat di Supabase.`);
    console.log(`\nSQL untuk membuat tabel:`);
    console.log(`   CREATE TABLE whatsapp_auth (`);
    console.log(`     session_id TEXT,`);
    console.log(`     key_id     TEXT,`);
    console.log(`     value      TEXT,`);
    console.log(`     created_at TIMESTAMPTZ DEFAULT now(),`);
    console.log(`     PRIMARY KEY (session_id, key_id)`);
    console.log(`   );`);
  }
}

uploadAuthToSupabase().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
