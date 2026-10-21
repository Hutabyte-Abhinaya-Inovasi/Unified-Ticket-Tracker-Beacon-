import { pgEmitter } from "../../database/supabase.js";
import { createClickUpTask } from "./clickupService.js";

export function startClickupListener() {
  console.log("🚀 ClickUp Listener aktif (Postgres)...");

  pgEmitter.on("Unified_Ticket_Tracker:insert", async (ticket) => {
    try {
      console.log("📥 INSERT TERDETEKSI (Postgres):", ticket.ticket_id);
      await createClickUpTask(ticket);
    } catch (err) {
      console.error("[ClickUp] ❌ Error handling ticket insert:", err.message);
    }
  });
}