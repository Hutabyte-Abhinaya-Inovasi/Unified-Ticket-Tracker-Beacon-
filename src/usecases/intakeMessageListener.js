import { supabase } from "../database/supabase.js";
//import { sendCandidateTicket } from "../infrastructure/telegram/telegramService.js";
import { sendIncidentAlert } from "../infrastructure/telegram/telegramService.js";

export function startIntakeMessageListener() {

    console.log("📡 Listening raw_intake_messages...");

    supabase
        .channel("intake_message")

        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "intake_message"
            },

            async (payload) => {
    try {

        const raw = payload.new;

        console.log("📥 Raw Intake Baru:", raw.id);

        // Ambil data asli dari Gmail/WhatsApp
        const original = raw.raw_payload || {};

        const telegramData = {
            id: raw.id,
            ticket_id: raw.ticket_id,

            from: original.from || raw.sender,
            subject: original.subject || "(No Subject)",
            body: original.body || raw.body_text,

            source: raw.source_channel,
            received_at: raw.received_at
        };

        console.log("📨 Telegram Data:", telegramData);

        await sendIncidentAlert(telegramData);

    } catch (err) {
        console.error(err);
    }
}

        )

        .subscribe((status) => {
        console.log("Realtime Status:", status);
        });

}