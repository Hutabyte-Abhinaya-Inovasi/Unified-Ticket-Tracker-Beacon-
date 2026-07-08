// src/uploadAuthToSupabase.js
//
// Script SATU KALI untuk mengupload isi folder auth_info/ lokal ke Supabase Storage.
// Jalankan ini dari lokal (saat WhatsApp sudah terhubung) sebelum deploy ke Railway.
//
// Usage: node src/uploadAuthToSupabase.js

import "dotenv/config";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";

// Polyfill WebSocket untuk Node.js < 22
globalThis.WebSocket = WebSocket;

const BUCKET_NAME = "whatsapp-auth";
const AUTH_FOLDER = "./auth_info";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET_NAME);

  if (!exists) {
    console.log(`📦 Membuat bucket "${BUCKET_NAME}"...`);
    const { error } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: false,
    });
    if (error) {
      console.error("❌ Gagal membuat bucket:", error.message);
      process.exit(1);
    }
    console.log(`✅ Bucket "${BUCKET_NAME}" berhasil dibuat`);
  } else {
    console.log(`✅ Bucket "${BUCKET_NAME}" sudah ada`);
  }
}

async function uploadFile(localPath, fileName) {
  const content = await readFile(localPath);
  const blob = new Blob([content], { type: "application/json" });

  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, blob, { upsert: true, contentType: "application/json" });

  if (error) {
    console.error(`  ❌ Gagal upload ${fileName}:`, error.message);
    return false;
  }
  return true;
}

async function main() {
  console.log("=".repeat(60));
  console.log("📤 WhatsApp Auth Uploader ke Supabase Storage");
  console.log("=".repeat(60));
  console.log(`📁 Sumber: ${AUTH_FOLDER}`);
  console.log(`🪣 Tujuan: Supabase Storage > ${BUCKET_NAME}`);
  console.log("");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ SUPABASE_URL dan SUPABASE_KEY harus diset di .env");
    process.exit(1);
  }

  // Pastikan bucket ada
  await ensureBucket();

  // Baca semua file di auth_info/
  let files;
  try {
    files = await readdir(AUTH_FOLDER);
  } catch (err) {
    console.error(`❌ Folder "${AUTH_FOLDER}" tidak ditemukan. Pastikan WhatsApp sudah pernah konek dari lokal!`);
    process.exit(1);
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json") || f.endsWith(".session"));
  console.log(`📋 Ditemukan ${jsonFiles.length} file untuk diupload:\n`);

  let successCount = 0;
  let failCount = 0;

  for (const file of jsonFiles) {
    const localPath = join(AUTH_FOLDER, file);
    process.stdout.write(`  ⬆️  ${file}... `);
    const ok = await uploadFile(localPath, file);
    if (ok) {
      console.log("✅");
      successCount++;
    } else {
      failCount++;
    }
  }

  console.log("");
  console.log("=".repeat(60));
  console.log(`📊 Hasil: ${successCount} berhasil, ${failCount} gagal`);

  if (successCount > 0 && failCount === 0) {
    console.log("");
    console.log("🎉 Semua file berhasil diupload!");
    console.log("");
    console.log("📌 Langkah selanjutnya:");
    console.log("   1. Push kode ke GitHub (Railway akan auto-deploy)");
    console.log("   2. Cek Railway logs — WhatsApp harus connect tanpa QR");
    console.log("   3. Jika QR tetap muncul, akan dikirim ke Telegram chat Anda");
  } else if (failCount > 0) {
    console.log("⚠️  Beberapa file gagal diupload. Coba jalankan ulang.");
  }

  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
