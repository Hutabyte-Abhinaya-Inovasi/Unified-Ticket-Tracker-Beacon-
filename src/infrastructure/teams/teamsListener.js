import { pgEmitter } from "../../database/supabase.js";
import { sendTeamsTicketAlert } from "./teamsService.js";

/**
 * Listener Realtime Postgres untuk tabel Unified_Ticket_Tracker.
 * Ketika ada tiket baru yang berhasil dibuat/dikonfirmasi,
 * notifikasi Adaptive Card otomatis dikirim ke Microsoft Teams.
 */
export function startTeamsListener() {
  console.log("🚀 Microsoft Teams Listener aktif (Postgres)...");

  pgEmitter.on("Unified_Ticket_Tracker:insert", async (ticket) => {
    try {
      console.log(`[Teams] 🎫 Tiket Baru Masuk: ${ticket.ticket_id}`);

      await sendTeamsTicketAlert({
        ticketId: ticket.ticket_id,
        subject: ticket.subject,
        severity: ticket.severity || ticket.priority || "MEDIUM",
        project: ticket.project,
        sourceChannel: ticket.source_channel,
        sender: ticket.sender,
        summary: ticket.summary || ticket.description,
      });
    } catch (err) {
      console.error("[Teams] ❌ Gagal mengirim tiket baru ke Teams:", err.message);
    }
  });
}
