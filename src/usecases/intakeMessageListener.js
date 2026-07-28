import { supabase } from "../database/supabase.js";
import { sendRawIntakeCandidate } from "../infrastructure/telegram/telegramService.js";

const processingIntakeIds = new Set();

async function safeSendCandidate(raw) {
  if (!raw || !raw.id) return;
  const idStr = String(raw.id);

  if (processingIntakeIds.has(idStr)) {
    console.log(`   🟡 Intake ${idStr} sedang/sudah dikirim ke Telegram, skip duplikat.`);
    return;
  }
  if (raw.raw_payload?.candidate_sent) {
    console.log(`   🟡 Intake ${idStr} sudah memiliki flag candidate_sent, skip.`);
    return;
  }

  processingIntakeIds.add(idStr);

  try {
    await sendRawIntakeCandidate(raw);
  } finally {
    // Biarkan ID berada di set selama 60 detik untuk mencegah duplikasi akibat race condition
    setTimeout(() => processingIntakeIds.delete(idStr), 60000);
  }
}

async function processPendingIntakesOnStartup() {
  try {
    const { data: pendingIntakes, error } = await supabase
      .from("intake_message")
      .select("id, source_channel, sender, raw_payload, body_text, received_at, ticket_id, status")
      .eq("status", "pending")
      .order("id", { ascending: true })
      .limit(15);

    if (error) {
      console.warn("⚠️ Gagal mengambil pending intake saat startup:", error.message);
      return;
    }

    const unsentIntakes = (pendingIntakes || []).filter(
      raw => !raw.raw_payload?.candidate_sent && !processingIntakeIds.has(String(raw.id))
    );

    if (unsentIntakes.length > 0) {
      console.log(`\n📥 Ditemukan ${unsentIntakes.length} intake pending yang belum terkirim ke Telegram. Memproses...`);
      for (const raw of unsentIntakes) {
        const idStr = String(raw.id);
        if (processingIntakeIds.has(idStr)) continue;
        console.log(`   [Replay Pending] Intake ID ${idStr} (${raw.source_channel}): ${raw.sender}`);
        await safeSendCandidate(raw);
        // Delay 500ms agar tidak terkena rate limit Telegram API (429)
        await new Promise(res => setTimeout(res, 500));
      }
    } else {
      console.log("   ✅ Tidak ada intake pending yang terlewat saat startup.");
    }
  } catch (err) {
    console.error("❌ Error processPendingIntakesOnStartup:", err.message);
  }
}

export function startIntakeMessageListener() {
  console.log("📡 Listening raw_intake_messages...");

  // Proses intake pending dari database saat pertama kali menyala
  processPendingIntakesOnStartup().catch(() => {});

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
          await safeSendCandidate(raw);
        } catch (err) {
          console.error("❌ Error processing new intake insert:", err.message);
        }
      }
    )
    .subscribe((status) => {
      console.log("Realtime Status:", status);
    });
}