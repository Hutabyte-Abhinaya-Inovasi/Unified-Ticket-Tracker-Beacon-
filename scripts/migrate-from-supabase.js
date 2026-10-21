import { createClient } from "@supabase/supabase-js";
import pkg from "pg";
const { Client } = pkg;
import dotenv from "dotenv";
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL atau SUPABASE_KEY belum ada di .env");
  process.exit(1);
}

import ws from "ws";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    transport: ws,
  },
});

// Konfigurasi PostgreSQL Lokal di VPS
const pgClient = new Client({
  host: "127.0.0.1",
  port: 5432,
  database: "ticket_tracker",
  user: "dbuser",
  password: "UTT@PantauTiket",
});

async function migrateTable(tableName, idCol = "id") {
  console.log(`\n⏳ Mengambil data dari Supabase tabel: "${tableName}"...`);
  
  // Dapatkan daftar kolom yang benar-benar ada di tabel target PostgreSQL lokal
  const colRes = await pgClient.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = $1 AND table_schema = 'public'
  `, [tableName]);
  const validColumns = new Set(colRes.rows.map(r => r.column_name));

  let offset = 0;
  const limit = 500;
  let totalMigrated = 0;

  while (true) {
    // Jika intake_message, gunakan filter id bertahap
    let query;
    if (tableName === "intake_message") {
      query = supabase
        .from(tableName)
        .select("*")
        .gte("id", offset + 1)
        .lte("id", offset + limit);
    } else {
      query = supabase
        .from(tableName)
        .select("*")
        .order(idCol, { ascending: true })
        .range(offset, offset + limit - 1);
    }

    const { data, error } = await query;

    if (error) {
      console.error(`❌ Gagal mengambil data tabel ${tableName} (offset ${offset}):`, error.message);
      break;
    }

    if (!data || data.length === 0) {
      if (offset === 0) {
        console.log(`ℹ️  Tabel "${tableName}" di Supabase kosong (0 baris).`);
      }
      break;
    }

    for (const row of data) {
      // Filter hanya kolom yang memang ada di skema PostgreSQL target
      const filteredKeys = Object.keys(row).filter(k => validColumns.has(k));
      const filteredValues = filteredKeys.map(k => row[k]);

      const columns = filteredKeys.map((k) => `"${k}"`).join(", ");
      const placeholders = filteredKeys.map((_, i) => `$${i + 1}`).join(", ");

      const query = `
        INSERT INTO public."${tableName}" (${columns})
        VALUES (${placeholders})
        ON CONFLICT DO NOTHING;
      `;

      try {
        await pgClient.query(query, filteredValues);
        totalMigrated++;
      } catch (err) {
        // Lewati jika error individual
      }
    }

    console.log(`📦 Berhasil mentransfer baris ${offset + 1} s/d ${offset + data.length} di "${tableName}".`);
    offset += limit;
    if (data.length < limit) break;
  }

  console.log(`✅ Selesai migrasi tabel "${tableName}". Total baris masuk: ${totalMigrated}`);
}

async function main() {
  try {
    await pgClient.connect();
    console.log("✅ Terhubung ke database PostgreSQL lokal (ticket_tracker)!");

    // Urutan migrasi tabel:
    await migrateTable("intake_message", "id");
    await migrateTable("Unified_Ticket_Tracker", "id");
    await migrateTable("conversation", "id");
    await migrateTable("teams_routing_rule", "id");
    await migrateTable("whatsapp_auth", "session_id");

    console.log("\n🎉 MIGRASI DARI SUPABASE KE POSTGRESQL SELESAI SEMPURNA!");
  } catch (err) {
    console.error("❌ Terjadi kesalahan saat migrasi:", err);
  } finally {
    await pgClient.end();
  }
}

main();
