// src/infrastructure/whatsapp/supabaseAuthState.js
//
// Custom auth state untuk Baileys yang menyimpan session ke Supabase Storage.
// Ini menggantikan useMultiFileAuthState agar session WhatsApp tetap persisten
// meski Railway melakukan redeploy (ephemeral filesystem).

import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

// Polyfill WebSocket untuk Node.js < 22
globalThis.WebSocket = WebSocket;

const BUCKET_NAME = "whatsapp-auth";

let supabase = null;

function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL dan SUPABASE_KEY harus diset di environment variables");
    }
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

/**
 * Baca satu file dari Supabase Storage.
 * @param {string} fileName - nama file (misal: "creds.json")
 * @returns {any|null} data yang sudah di-parse, atau null jika tidak ada
 */
async function readData(fileName) {
  try {
    const sb = getSupabase();
    const { data, error } = await sb.storage
      .from(BUCKET_NAME)
      .download(fileName);

    if (error) {
      // File tidak ada = normal saat pertama kali
      if (error.message?.includes("not found") || error.statusCode === 404) {
        return null;
      }
      console.error(`⚠️ [SupabaseAuth] Gagal baca ${fileName}:`, error.message);
      return null;
    }

    const text = await data.text();
    return JSON.parse(text, BufferJSON.reviver);
  } catch (err) {
    console.error(`⚠️ [SupabaseAuth] Error saat baca ${fileName}:`, err.message);
    return null;
  }
}

/**
 * Tulis satu file ke Supabase Storage.
 * @param {string} fileName - nama file
 * @param {any} data - data yang akan disimpan (akan di-JSON.stringify)
 */
async function writeData(fileName, data) {
  try {
    const sb = getSupabase();
    const content = JSON.stringify(data, BufferJSON.replacer, 2);
    const blob = new Blob([content], { type: "application/json" });

    const { error } = await sb.storage
      .from(BUCKET_NAME)
      .upload(fileName, blob, {
        upsert: true,
        contentType: "application/json",
      });

    if (error) {
      console.error(`⚠️ [SupabaseAuth] Gagal tulis ${fileName}:`, error.message);
    }
  } catch (err) {
    console.error(`⚠️ [SupabaseAuth] Error saat tulis ${fileName}:`, err.message);
  }
}

/**
 * Hapus satu file dari Supabase Storage.
 * @param {string} fileName - nama file
 */
async function removeData(fileName) {
  try {
    const sb = getSupabase();
    const { error } = await sb.storage.from(BUCKET_NAME).remove([fileName]);
    if (error) {
      console.error(`⚠️ [SupabaseAuth] Gagal hapus ${fileName}:`, error.message);
    }
  } catch (err) {
    console.error(`⚠️ [SupabaseAuth] Error saat hapus ${fileName}:`, err.message);
  }
}

/**
 * Pastikan bucket "whatsapp-auth" sudah ada di Supabase Storage.
 * Jika belum ada, coba buat (perlu permission yang cukup).
 */
async function ensureBucketExists() {
  const sb = getSupabase();

  // Cek apakah bucket sudah ada
  const { data: buckets, error: listErr } = await sb.storage.listBuckets();
  if (listErr) {
    console.warn("⚠️ [SupabaseAuth] Tidak bisa cek bucket list:", listErr.message);
    return;
  }

  const exists = buckets?.some((b) => b.name === BUCKET_NAME);
  if (!exists) {
    console.log(`📦 [SupabaseAuth] Membuat bucket "${BUCKET_NAME}"...`);
    const { error: createErr } = await sb.storage.createBucket(BUCKET_NAME, {
      public: false,
    });
    if (createErr) {
      console.error(`❌ [SupabaseAuth] Gagal buat bucket:`, createErr.message);
    } else {
      console.log(`✅ [SupabaseAuth] Bucket "${BUCKET_NAME}" berhasil dibuat`);
    }
  } else {
    console.log(`✅ [SupabaseAuth] Bucket "${BUCKET_NAME}" sudah ada`);
  }
}

/**
 * Pengganti useMultiFileAuthState dari Baileys yang menyimpan session ke Supabase.
 * Usage: const { state, saveCreds } = await useSupabaseAuthState();
 */
export async function useSupabaseAuthState() {
  await ensureBucketExists();

  // Load credentials utama
  const creds = (await readData("creds.json")) || initAuthCreds();

  const keys = {};

  /**
   * Mendapatkan key dengan type dan IDs tertentu dari Supabase.
   */
  async function getKeys(type, ids) {
    const data = {};
    await Promise.all(
      ids.map(async (id) => {
        let value = keys[`${type}-${id}`];
        if (!value) {
          value = await readData(`${type}-${id}.json`);
          if (value) keys[`${type}-${id}`] = value;
        }
        if (value) {
          // Decode pre-keys dan sender keys khusus
          if (type === "pre-key") {
            value = { keyPair: value };
          } else if (type === "session") {
            value = proto.Message.Session.decode(
              Buffer.from(value?.base64 ?? value, "base64")
            );
          } else if (type === "sender-key") {
            value = proto.Message.SenderKeyRecord.decode(
              Buffer.from(value?.base64 ?? value, "base64")
            );
          } else if (type === "app-state-sync-key") {
            value = proto.Message.AppStateSyncKeyData.decode(
              Buffer.from(value?.base64 ?? value, "base64")
            );
          } else if (type === "app-state-sync-version") {
            // Langsung pakai
          } else if (type === "sender-key-memory") {
            // Langsung pakai
          }
          data[id] = value;
        }
      })
    );
    return data;
  }

  /**
   * Menyimpan key-keys ke Supabase.
   */
  async function setKeys(type, data) {
    await Promise.all(
      Object.entries(data).map(async ([id, value]) => {
        let toSave = value;

        if (type === "pre-key") {
          toSave = value.keyPair;
        } else if (type === "session") {
          toSave = {
            base64: Buffer.from(proto.Message.Session.encode(value).finish()).toString("base64"),
          };
        } else if (type === "sender-key") {
          toSave = {
            base64: Buffer.from(proto.Message.SenderKeyRecord.encode(value).finish()).toString("base64"),
          };
        } else if (type === "app-state-sync-key") {
          toSave = {
            base64: Buffer.from(proto.Message.AppStateSyncKeyData.encode(value).finish()).toString("base64"),
          };
        }

        if (toSave) {
          keys[`${type}-${id}`] = value;
          await writeData(`${type}-${id}.json`, toSave);
        } else if (toSave === null || toSave === undefined) {
          delete keys[`${type}-${id}`];
          await removeData(`${type}-${id}.json`);
        }
      })
    );
  }

  const state = {
    creds,
    keys: {
      get: getKeys,
      set: setKeys,
    },
  };

  /**
   * Dipanggil setiap kali credentials berubah (misal setelah scan QR).
   */
  async function saveCreds() {
    await writeData("creds.json", state.creds);
  }

  return { state, saveCreds };
}
