import { supabase } from "../database/supabase.js";
import { createClickUpTask } from "../infrastructure/clickup/clickupService.js";

const { data, error } = await supabase
    .from("Unified_Ticket_Tracker")
    .select("*")
    .order("processed_at", { ascending: false })
    .limit(1)
    .single();

if (error) {
    console.log(error);
    process.exit();
}

console.log(data);

await createClickUpTask(data);

console.log("Selesai");