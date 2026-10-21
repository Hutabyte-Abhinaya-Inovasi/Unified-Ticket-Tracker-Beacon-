// src/database/postgres.js
import pkg from "pg";
const { Pool, Client } = pkg;
import { env } from "../config/env.js";
import { EventEmitter } from "events";

export const pgPool = new Pool({
  host: process.env.PG_HOST || "127.0.0.1",
  port: parseInt(process.env.PG_PORT || "5432", 10),
  database: process.env.PG_DATABASE || "ticket_tracker",
  user: process.env.PG_USER || "dbuser",
  password: process.env.PG_PASSWORD || "UTT@PantauTiket",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pgPool.on("error", (err) => {
  console.error("❌ Postgres Pool unexpected error:", err.message);
});

export const pgEmitter = new EventEmitter();

let listenerClient = null;

export async function initPostgresListener() {
  if (listenerClient) return;

  try {
    listenerClient = new Client({
      host: process.env.PG_HOST || "127.0.0.1",
      port: parseInt(process.env.PG_PORT || "5432", 10),
      database: process.env.PG_DATABASE || "ticket_tracker",
      user: process.env.PG_USER || "dbuser",
      password: process.env.PG_PASSWORD || "UTT@PantauTiket",
    });

    await listenerClient.connect();
    await listenerClient.query("LISTEN intake_message_events;");
    await listenerClient.query("LISTEN \"Unified_Ticket_Tracker_events\";");

    listenerClient.on("notification", (msg) => {
      try {
        const payload = JSON.parse(msg.payload);
        if (msg.channel === "intake_message_events") {
          pgEmitter.emit("intake_message:insert", payload);
        } else if (msg.channel === "Unified_Ticket_Tracker_events") {
          pgEmitter.emit("Unified_Ticket_Tracker:insert", payload);
        }
      } catch (err) {
        console.error("❌ Error parsing notification payload:", err.message);
      }
    });

    listenerClient.on("error", (err) => {
      console.error("❌ Postgres Listener client error:", err.message);
      listenerClient = null;
      setTimeout(initPostgresListener, 5000);
    });

    console.log("📡 Postgres LISTEN / NOTIFY realtime listener aktif!");
  } catch (err) {
    console.error("❌ Gagal menginisialisasi Postgres Listener:", err.message);
    listenerClient = null;
    setTimeout(initPostgresListener, 5000);
  }
}

// Inisialisasi otomatis listener saat modul di-load
initPostgresListener().catch(() => {});
