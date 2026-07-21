// src/infrastructure/whatsapp/supabaseAuthState.js
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";

/**
 * Custom auth state untuk Baileys menggunakan Supabase
 * agar session WhatsApp tetap tersimpan secara persisten meskipun dideploy di Railway.
 * 
 * Skema Tabel Supabase yang dibutuhkan (whatsapp_auth):
 * - session_id (TEXT)
 * - key_id (TEXT)
 * - value (TEXT)
 * - PRIMARY KEY (session_id, key_id)
 */
export async function useSupabaseAuthState(supabaseClient, sessionId = "default-session") {
  
  const writeData = async (data, id) => {
    try {
      const json = JSON.stringify(data, BufferJSON.replacer);
      const { error } = await supabaseClient
        .from("whatsapp_auth")
        .upsert({
          session_id: sessionId,
          key_id: id,
          value: json
        }, { onConflict: "session_id,key_id" });

      if (error) {
        console.error(`❌ [SupabaseAuth] Gagal menyimpan data untuk key_id: ${id}`, error.message);
      }
    } catch (err) {
      console.error(`❌ [SupabaseAuth] Error saat menulis data:`, err.message);
    }
  };

  const readData = async (id) => {
    try {
      const { data, error } = await supabaseClient
        .from("whatsapp_auth")
        .select("value")
        .eq("session_id", sessionId)
        .eq("key_id", id)
        .maybeSingle();

      if (error) {
        console.error(`❌ [SupabaseAuth] Gagal membaca data untuk key_id: ${id}`, error.message);
        return null;
      }

      if (!data || !data.value) return null;
      return JSON.parse(data.value, BufferJSON.reviver);
    } catch (err) {
      console.error(`❌ [SupabaseAuth] Error saat membaca data untuk key_id: ${id}`, err.message);
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      const { error } = await supabaseClient
        .from("whatsapp_auth")
        .delete()
        .eq("session_id", sessionId)
        .eq("key_id", id);

      if (error) {
        console.error(`❌ [SupabaseAuth] Gagal menghapus data untuk key_id: ${id}`, error.message);
      }
    } catch (err) {
      console.error(`❌ [SupabaseAuth] Error saat menghapus data:`, err.message);
    }
  };

  // Baca credentials utama, jika belum ada maka buat yang baru
  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                // Modifikasi objek jika tipe app-state-sync-key
                value = value; 
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, "creds");
    }
  };
}
