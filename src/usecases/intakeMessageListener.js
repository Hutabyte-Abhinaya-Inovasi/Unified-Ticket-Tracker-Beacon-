import { supabase } from "../database/supabase.js";
import { sendRawIntakeCandidate } from "../infrastructure/telegram/telegramService.js";
import { sendTeamsCandidateAlert } from "../infrastructure/teams/teamsService.js";
import { extractEmailMentions } from "../infrastructure/email/emailHelper.js";

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
    // Ambil data lengkap langsung dari database berdasarkan ID
    // agar body_text dan raw_payload tidak hilang/terpotong akibat limitasi Supabase Realtime WebSocket / Postgres TOAST!
    let activeRaw = raw;
    if (raw.id) {
      try {
        const { data: dbRecord } = await supabase
          .from("intake_message")
          .select("*")
          .eq("id", raw.id)
          .single();
        if (dbRecord) activeRaw = dbRecord;
      } catch (_) {}
    }

    // 1. Kirim ke Telegram (Beacon Ticket Operations)
    await sendRawIntakeCandidate(activeRaw);

    // 2. Kirim juga ke Microsoft Teams Channel
    const payload = activeRaw.raw_payload || {};
    const body = activeRaw.body_text || "";
    const mentions = payload.mentions || extractEmailMentions(body, payload.html);
    const subject = payload.subject || activeRaw.subject || "(No Subject)";

    await sendTeamsCandidateAlert({
      intakeId: activeRaw.id,
      subject: subject,
      sender: activeRaw.sender,
      body: body,
      taggedPersons: mentions,
      receivedAt: activeRaw.received_at,
      channel: activeRaw.source_channel || "email",
    }).catch((err) => console.error("[Teams-Intake] Gagal kirim kandidat ke Teams:", err.message));
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
      .order("id", { ascending: false })
      .limit(50);

    if (error) {
      console.warn("⚠️ Gagal mengambil pending intake saat startup:", error.message);
      return;
    }

    const unsentIntakes = (pendingIntakes || [])
      .filter(
        raw => !raw.raw_payload?.candidate_sent && !processingIntakeIds.has(String(raw.id))
      )
      .sort((a, b) => a.id - b.id);

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

import { pgEmitter } from "../database/supabase.js";

export function startIntakeMessageListener() {
  console.log("📡 Listening raw_intake_messages via Postgres Realtime...");

  // Proses intake pending dari database saat pertama kali menyala
  processPendingIntakesOnStartup().catch(() => {});

  pgEmitter.on("intake_message:insert", async (raw) => {
    try {
      console.log("📥 Raw Intake Baru (Postgres):", raw.id);
      await safeSendCandidate(raw);
    } catch (err) {
      console.error("❌ Error processing new intake insert:", err.message);
    }
  });
}