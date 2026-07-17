// src/infrastructure/telegram/telegramUserListener.js
//
// Telegram PERSONAL ACCOUNT Listener menggunakan MTProto (gramjs)
// ─────────────────────────────────────────────────────────────────
// Berbeda dari Bot API, listener ini login sebagai user biasa (nomor HP)
// sehingga bisa menangkap semua pesan masuk ke DM akun tersebut.
//
// ALUR:
//   1. Login dengan nomor HP → OTP via Telegram → session tersimpan
//   2. Dengarkan NewMessage di private chat (DM)
//   3. Simpan raw ke Supabase
//   4. Proses AI untuk ekstraksi field tiket
//   5. Kirim alert ke grup via Bot yang sudah ada

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { env } from '../../config/env.js';
import { saveRawIntakeMessage, supabase } from '../../database/supabase.js';
import { extractTicketFields } from '../ai/openaiService.js';
import { sendIncidentAlert } from './telegramService.js';
import { processRawMessage } from '../../usecases/processRawMessage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────
// KONFIGURASI MULTI-AKUN
// Untuk sekarang hanya 1 akun dari .env
// Di masa depan bisa diperluas ke array akun
// ──────────────────────────────────────────────────────────────────
function buildAccountConfig() {
  if (!env.TG_API_ID || !env.TG_API_HASH || !env.TG_PHONE_NUMBER) {
    return null;
  }
  return {
    apiId: env.TG_API_ID,
    apiHash: env.TG_API_HASH,
    phoneNumber: env.TG_PHONE_NUMBER,
    twoFaPassword: env.TG_2FA_PASSWORD || null,
    sessionFile: join(__dirname, '..', '..', '..', 'auth_info', `tg_user_${sanitizePhone(env.TG_PHONE_NUMBER)}.session`),
  };
}

function sanitizePhone(phone) {
  return phone.replace(/[^0-9]/g, '');
}

// ──────────────────────────────────────────────────────────────────
// HELPER: Baca / Tulis Session String dari file
// ──────────────────────────────────────────────────────────────────
function loadSession(sessionFile) {
  // Prioritas 1: dari environment variable (untuk deployment di server)
  if (env.TG_SESSION_STRING && env.TG_SESSION_STRING.trim() !== '') {
    console.log(`   🔑 Session dimuat dari TG_SESSION_STRING (env)`);
    return env.TG_SESSION_STRING.trim();
  }
  // Prioritas 2: dari file lokal
  try {
    if (existsSync(sessionFile)) {
      const raw = readFileSync(sessionFile, 'utf8').trim();
      console.log(`   📂 Session ditemukan: ${sessionFile}`);
      return raw;
    }
  } catch (err) {
    console.warn(`⚠️  Gagal membaca session file: ${err.message}`);
  }
  return '';
}

function saveSession(sessionFile, sessionString) {
  try {
    const dir = dirname(sessionFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sessionFile, sessionString, 'utf8');
    console.log(`   💾 Session disimpan: ${sessionFile}`);
  } catch (err) {
    console.error(`❌ Gagal menyimpan session: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// HELPER: Prompt interaktif untuk OTP / Password
// ──────────────────────────────────────────────────────────────────
function createPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// CORE: Mulai listener untuk satu akun
// ──────────────────────────────────────────────────────────────────

/**
 * Cek apakah kita sedang berjalan di server (Railway, Docker, CI)
 * atau di mesin developer lokal.
 * Di lokal: selalu bisa input OTP interaktif.
 * Di Railway/Docker/CI: tidak ada input interaktif.
 */
function isInteractiveEnvironment() {
  // Railway menyuntikkan RAILWAY_ENVIRONMENT
  if (process.env.RAILWAY_ENVIRONMENT) return false;
  // Flag CI standar (GitHub Actions, dsb.)
  if (process.env.CI === 'true') return false;
  // Jika eksplisit diset oleh user
  if (process.env.NON_INTERACTIVE === 'true') return false;
  // Di lokal selalu anggap interaktif
  return true;
}

// ──────────────────────────────────────────────────────────────────
// REPLAY: Proses DM yang masuk saat listener offline
// Mengambil pesan dari 24 jam terakhir dan memproses yang belum ada
// di Supabase (dicek via idempotency_key). Aman dijalankan berulang
// karena idempotency_key mencegah duplikasi.
// ──────────────────────────────────────────────────────────────────
async function replayMissedDMs(client, me, displayName, phoneNumber) {
  console.log(`\n🔄 Memeriksa DM yang terlewat saat listener offline...`);
  const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 jam lalu
  const myId = me.id?.toString();
  let replayCount = 0;

  try {
    const dialogs = await client.getDialogs({ limit: 30 });

    for (const dialog of dialogs) {
      // Hanya proses private chat (DM), bukan grup/channel
      if (!dialog.isUser) continue;
      if (!dialog.entity) continue;

      const peer = dialog.entity;
      const peerId = peer.id?.toString();

      // Skip diri sendiri
      if (peerId === myId) continue;

      let messages;
      try {
        messages = await client.getMessages(peer, { limit: 10 });
      } catch (err) {
        continue; // skip jika error pada chat ini
      }

      for (const message of messages) {
        if (!message.text) continue;
        if (message.out) continue; // abaikan pesan keluar (dari kita)

        const msgDate = new Date(message.date * 1000);
        if (msgDate < cutoffDate) break; // sudah diurutkan terbaru → stop

        const idempotencyKey = `tg_dm_${message.id}`;

        // Cek apakah sudah ada di Supabase
        const { data: existing } = await supabase
          .from('intake_message')
          .select('id')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();

        if (existing) continue; // sudah diproses sebelumnya

        const senderName = [peer.firstName, peer.lastName].filter(Boolean).join(' ')
          || peer.username
          || `User_${peerId}`;
        const senderPhone = peer.phone ? `+${peer.phone}` : null;
        const timestamp = msgDate.toISOString();

        console.log(`   📩 [REPLAY] DM terlewat dari: ${senderName} (${timestamp})`);
        console.log(`      Pesan: ${message.text.substring(0, 80)}${message.text.length > 80 ? '...' : ''}`);

        const raw = await saveRawIntakeMessage({
          source_channel:  'telegram',
          source_ref:      peerId,
          sender:          senderPhone
                             ? `${senderName} (${senderPhone})`
                             : `${senderName} (${peerId})`,
          thread_ref:      null,
          received_at:     timestamp,
          body_text:       message.text,
          attachments:     null,
          raw_payload: {
            group_name:      `DM → ${displayName} (${phoneNumber})`,
            telegram_msg_id: message.id?.toString(),
            sender_id:       peerId,
            receiver_phone:  phoneNumber,
            receiver_name:   displayName,
            replayed:        true,
          },
          idempotency_key: idempotencyKey,
        });

        if (raw) {
          await processRawMessage({
            ...(raw || {}),
            id:             raw?.id || null,
            source_channel: 'telegram',
            source_ref:     peerId,
            sender:         senderPhone ? `${senderName} (${senderPhone})` : `${senderName} (${peerId})`,
            body_text:      message.text,
            raw_payload: {
              group_name:      `DM → ${displayName} (${phoneNumber})`,
              telegram_msg_id: message.id?.toString(),
            },
            idempotency_key: idempotencyKey,
          });
          replayCount++;
        }
      }
    }

    if (replayCount > 0) {
      console.log(`   ✅ ${replayCount} DM terlewat berhasil diproses!`);
    } else {
      console.log(`   ✅ Tidak ada DM terlewat dalam 24 jam terakhir.`);
    }

  } catch (err) {
    console.warn(`   ⚠️  Replay DM gagal (tidak kritis): ${err.message}`);
  }
}

async function startUserAccount(account) {
  const { apiId, apiHash, phoneNumber, twoFaPassword, sessionFile } = account;

  console.log(`\n📱 Memulai Telegram User Listener...`);
  console.log(`   Nomor   : ${phoneNumber}`);
  console.log(`   api_id  : ${apiId}`);

  // ── CEK AWAL: Session harus ada jika di server ──
  const savedSession = loadSession(sessionFile);

  if (!savedSession) {
    if (!isInteractiveEnvironment()) {
      // Di Railway/server: tidak bisa input OTP, skip saja
      console.warn(`\n⚠️  [Telegram User] Tidak ada session yang tersimpan.`);
      console.warn(`   Di server non-interaktif, tidak bisa meminta OTP.`);
      console.warn(`   👉 Jalankan dulu di lokal, login OTP sekali, lalu salin TG_SESSION_STRING ke Railway.`);
      return null;
    }
    console.log(`   📭 Belum ada session tersimpan. Akan meminta OTP...`);
  }

  const stringSession = new StringSession(savedSession || '');

  // Buat client gramjs
  const client = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
    connectionRetries: 3,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS: false,
  });

  // ── Tangani flood wait sebelum memulai ──
  let otpFloodWait = 0;

  // ── Login (jika session kosong, akan meminta OTP) ──
  try {
    await client.start({
      phoneNumber: async () => phoneNumber,

      password: async () => {
        if (twoFaPassword) {
          console.log(`   🔐 Menggunakan 2FA password dari .env`);
          return twoFaPassword;
        }
        if (!isInteractiveEnvironment()) {
          throw new Error('TG_2FA_PASSWORD tidak diset di .env, dan lingkungan non-interaktif tidak bisa meminta input.');
        }
        return await createPrompt(`\n🔐 Masukkan password 2FA Telegram (${phoneNumber}): `);
      },

      phoneCode: async () => {
        if (!isInteractiveEnvironment()) {
          throw new Error('Lingkungan non-interaktif tidak bisa menerima kode OTP.');
        }
        const code = await createPrompt(
          `\n📲 Kode OTP telah dikirim Telegram ke ${phoneNumber}.\n   Masukkan kode OTP: `
        );
        return code;
      },

      onError: (err) => {
        const msg = err.message || '';
        // Deteksi flood wait — catat durasi dan JANGAN retry
        const floodMatch = msg.match(/wait of (\d+) seconds/i);
        if (floodMatch) {
          otpFloodWait = parseInt(floodMatch[1]);
          console.error(`\n🚫 [Telegram] Flood wait aktif — Telegram membatasi permintaan OTP.`);
          console.error(`   Coba lagi dalam ${Math.ceil(otpFloodWait / 60)} menit (${otpFloodWait} detik).`);
          // Lempar error agar client.start() berhenti, bukan retry
          throw err;
        }
        console.error(`❌ Error login Telegram User (${phoneNumber}):`, msg);
        throw err;
      },
    });
  } catch (err) {
    const msg = err.message || '';
    if (msg.match(/wait of \d+ seconds/i) || otpFloodWait > 0) {
      console.warn(`\n⏳ Telegram User Listener dilewati sementara karena flood wait.`);
      console.warn(`   Bot dan WhatsApp tetap berjalan normal.`);
      return null;  // Jangan crash, biarkan service lain jalan
    }
    if (msg.includes('non-interaktif') || msg.includes('tidak bisa')) {
      console.warn(`\n⚠️  Telegram User Listener dilewati: ${msg}`);
      return null;
    }
    console.error(`❌ Gagal login Telegram User (${phoneNumber}):`, msg);
    return null;
  }

  // Simpan session setelah berhasil login
  const newSession = client.session.save();
  saveSession(sessionFile, newSession);

  // Ambil info akun yang sedang login
  const me = await client.getMe();
  const displayName = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || phoneNumber;
  console.log(`\n✅ Telegram User Login Berhasil!`);
  console.log(`   Akun    : ${displayName} (@${me.username || '-'})`);
  console.log(`   ID      : ${me.id}`);
  console.log(`   Nomor   : ${phoneNumber}`);
  console.log(`\n👂 Mendengarkan pesan masuk DM ke akun ini...`);

  // ── REPLAY: Tangkap DM yang masuk saat listener offline ──
  await replayMissedDMs(client, me, displayName, phoneNumber);

  // ── EVENT LISTENER: Tangkap pesan DM baru ──
  client.addEventHandler(
    async (event) => {
      try {
        const message = event.message;
        if (!message || !message.text) return;

        // Dapatkan info chat dan pengirim
        const chat = await message.getChat().catch(() => null);
        const sender = await message.getSender().catch(() => null);

        // Hanya proses private chat (DM), skip grup dan channel
        // className 'User' berarti chat 1-on-1
        if (!chat || chat.className !== 'User') return;

        // Abaikan pesan dari diri sendiri
        const myId = me.id?.toString();
        const senderId = sender?.id?.toString() || 'unknown';
        if (senderId === myId) return;

        // Abaikan pesan dari bot itu sendiri (berdasarkan username dari .env)
        if (env.TG_BOT_USERNAME && sender?.username === env.TG_BOT_USERNAME) {
          console.log(`   🟡 Pesan dari bot (@${sender.username}) diabaikan.`);
          return;
        }

        const senderName = [sender?.firstName, sender?.lastName].filter(Boolean).join(' ')
          || sender?.username
          || `User_${senderId}`;
        const senderPhone = sender?.phone ? `+${sender.phone}` : null;
        const messageText = message.text;
        const messageId = message.id?.toString();
        const timestamp = new Date(message.date * 1000).toISOString();

        console.log(`\n📩 [Telegram DM] Pesan Baru Masuk`);
        console.log(`   Akun Support : ${phoneNumber}`);
        console.log(`   Dari         : ${senderName}${senderPhone ? ` (${senderPhone})` : ''}`);
        console.log(`   Waktu        : ${timestamp}`);
        console.log(`   Pesan        : ${messageText.substring(0, 120)}${messageText.length > 120 ? '...' : ''}`);

        // ── STEP 1: Simpan raw ke intake_message (skema baru) ──
        const raw = await saveRawIntakeMessage({
          source_channel:  'telegram',
          source_ref:      senderId,                   // DM → source_ref = sender's user ID
          sender:          senderPhone
                             ? `${senderName} (${senderPhone})`
                             : `${senderName} (${senderId})`,
          thread_ref:      null,                       // Telegram DM tidak punya quote ID di MTProto
          received_at:     timestamp,
          body_text:       messageText,
          attachments:     null,
          raw_payload:     {
            group_name:      `DM → ${displayName} (${phoneNumber})`,
            telegram_msg_id: messageId,
            sender_id:       senderId,
            receiver_phone:  phoneNumber,
            receiver_name:   displayName,
          },
          idempotency_key: `tg_dm_${messageId}`,      // unik per pesan Telegram
        });

        if (raw) {
          console.log(`   💾 Raw data tersimpan (id: ${raw.id})`);
        }

        // ── STEP 2: Proses via pipeline terpadu ──
        // processRawMessage menangani: small talk → relevance → threading → tiket baru
        console.log(`   🤖 Memproses dengan pipeline standar...`);
        await processRawMessage({
          ...(raw || {}),
          // Pastikan field wajib tersedia meski raw save gagal
          id:              raw?.id || null,
          source_channel:  'telegram',
          source_ref:      senderId,
          sender:          senderPhone ? `${senderName} (${senderPhone})` : `${senderName} (${senderId})`,
          body_text:       messageText,
          raw_payload:     {
            group_name:    `DM → ${displayName} (${phoneNumber})`,
            telegram_msg_id: messageId,
          },
          idempotency_key: `tg_dm_${messageId}`,
        });

        console.log(`   ✅ Pemrosesan selesai`);


      } catch (err) {
        console.error(`❌ Error memproses DM Telegram:`, err.message, err.stack);
      }
    },
    new NewMessage({ incoming: true })
  );

  // Nonaktifkan log internal gramjs (terlalu verbose)
  client.setLogLevel('none');

  return client;
}

// ──────────────────────────────────────────────────────────────────
// EXPORT: Fungsi utama yang dipanggil dari index.js
// ──────────────────────────────────────────────────────────────────
const activeClients = [];

export async function startTelegramUserListener() {
  const account = buildAccountConfig();

  if (!account) {
    console.warn(`\n⚠️  [Telegram Personal Listener] Dilewati.`);
    console.warn(`   Set TG_API_ID, TG_API_HASH, dan TG_PHONE_NUMBER di .env untuk mengaktifkan.`);
    return null;
  }

  try {
    const client = await startUserAccount(account);
    activeClients.push({ phone: account.phoneNumber, client });
    return client;
  } catch (err) {
    console.error(`❌ Gagal memulai Telegram User Listener:`, err.message);
    // Tidak throw — biarkan sistem lain tetap berjalan
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// FUNGSI UNTUK MULTI-AKUN (siap untuk masa depan)
// Tambahkan nomor HP baru dengan memanggil addUserAccount()
// Contoh:
//   import { addUserAccount } from './telegramUserListener.js';
//   await addUserAccount({ apiId: 999, apiHash: 'xxx', phoneNumber: '+628999...' });
// ──────────────────────────────────────────────────────────────────
export async function addUserAccount({ apiId, apiHash, phoneNumber, twoFaPassword = null }) {
  const sessionFile = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'auth_info',
    `tg_user_${sanitizePhone(phoneNumber)}.session`
  );

  const account = { apiId, apiHash, phoneNumber, twoFaPassword, sessionFile };

  try {
    const client = await startUserAccount(account);
    activeClients.push({ phone: phoneNumber, client });
    console.log(`✅ Akun ${phoneNumber} berhasil ditambahkan ke listener.`);
    return client;
  } catch (err) {
    console.error(`❌ Gagal menambah akun ${phoneNumber}:`, err.message);
    throw err;
  }
}

/** Kembalikan daftar semua akun yang sedang aktif */
export function getActiveClients() {
  return activeClients.map(({ phone }) => phone);
}
