import { supabase } from "../../database/supabase.js";
import { createClickUpTask } from "./clickupService.js";

export function startClickupListener() {

    console.log("🚀 ClickUp Listener aktif...");

    const channel = supabase
        .channel("clickup-sync")
        .on(
            "postgres_changes",
            {
                event: "INSERT",
                schema: "public",
                table: "Unified_Ticket_Tracker"
            },
            async (payload) => {

                console.log("📥 INSERT TERDETEKSI");
                console.log(payload.new);

                await createClickUpTask(payload.new);

            }
        )
        .subscribe((status) => {
            console.log("Realtime Status:", status);
        });

    return channel;
}