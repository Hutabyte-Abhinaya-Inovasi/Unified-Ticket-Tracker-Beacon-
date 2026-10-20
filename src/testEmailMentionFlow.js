// src/testEmailMentionFlow.js
import 'dotenv/config';
import { extractEmailMentions } from './infrastructure/email/emailHelper.js';
import { saveRawIntakeMessage, supabase } from './database/supabase.js';
import { sendRawIntakeCandidate } from './infrastructure/telegram/telegramService.js';
import { sendTeamsCandidateAlert } from './infrastructure/teams/teamsService.js';
import { formatCandidateTicket } from './infrastructure/telegram/telegramFormatter.js';

async function runTest() {
  console.log("=================================================");
  console.log("🧪 TESTING SIMULASI EMAIL DENGAN TAG @NAMA ORANG");
  console.log("=================================================");

  const rawEmail = {
    subject: "RE: Push Event ke msgbkrpapp59.telkomsel.co.id:29092 topic SOURCE-WORKFLOW-TCFMC",
    from: '"l2 support" <l2.support@tritronik.com>',
    bodyText: `Dear pak @Andri Sofyana\n\nmailto:andri.sofyana@phincon.com\n Baik, segera di push pak`,
    html: `<div class="elementToProof">Dear pak <a href="mailto:andri.sofyana@phincon.com" class="tWKOu mention">@Andri Sofyana</a><br><br>Baik, segera di push pak</div>`,
  };

  console.log("\n1. 🔍 Mengekstrak mention dari isi email...");
  const mentions = extractEmailMentions(rawEmail.bodyText, rawEmail.html);
  console.log("   Hasil ekstraksi mention:", mentions);

  if (mentions.length === 0 || mentions[0].name !== "Andri Sofyana") {
    console.error("❌ Gagal mengekstrak nama @Andri Sofyana!");
    process.exit(1);
  }
  console.log("   ✅ Berhasil ekstrak PIC yang di-tag: @" + mentions[0].name + " (" + mentions[0].email + ")");

  console.log("\n2. 💾 Menyimpan email ke tabel intake_message (Status: Pending)...");
  const uniqueMsgId = `test-email-${Date.now()}`;
  const savedIntake = await saveRawIntakeMessage({
    source_channel: "email",
    source_ref: uniqueMsgId,
    sender: rawEmail.from,
    thread_ref: uniqueMsgId,
    received_at: new Date().toISOString(),
    body_text: rawEmail.bodyText,
    attachments: { count: 0 },
    raw_payload: {
      subject: rawEmail.subject,
      from: { text: rawEmail.from, address: "l2.support@tritronik.com", name: "l2 support" },
      to: [{ name: "Andri Sofyana", address: "andri.sofyana@phincon.com" }],
      html: rawEmail.html,
      mentions: mentions,
      has_mentions: true,
    },
    idempotency_key: uniqueMsgId,
  });

  if (!savedIntake || !savedIntake.id) {
    console.error("❌ Gagal simpan ke intake_message!");
    process.exit(1);
  }
  console.log(`   ✅ Berhasil tersimpan ke intake_message dengan Intake ID: ${savedIntake.id}`);

  // Ambil record lengkap
  const { data: fullIntake } = await supabase
    .from('intake_message')
    .select('*')
    .eq('id', savedIntake.id)
    .single();

  console.log("\n3. 📱 Memformat tampilan notifikasi kandidat...");
  const formattedText = formatCandidateTicket(fullIntake);
  console.log("   Cuplikan teks Telegram:\n" + formattedText.slice(0, 450) + "...\n");

  console.log("4. 🚀 Mengirim notifikasi kandidat ke Telegram (Beacon Ticket Operations)...");
  try {
    const tgSent = await sendRawIntakeCandidate(fullIntake);
    console.log(`   ✅ Notifikasi Telegram terkirim (Msg ID: ${tgSent?.message_id || 'OK'})`);
  } catch (err) {
    console.error("   ⚠️ Telegram gagal kirim:", err.message);
  }

  console.log("\n5. 📢 Mengirim notifikasi kandidat ke Microsoft Teams (Adaptive Card)...");
  try {
    const teamsSent = await sendTeamsCandidateAlert({
      intakeId: fullIntake.id,
      subject: rawEmail.subject,
      sender: fullIntake.sender,
      body: fullIntake.body_text,
      taggedPersons: mentions,
      receivedAt: fullIntake.received_at,
      channel: "email",
    });
    console.log(`   ${teamsSent ? '✅ Notifikasi Teams berhasil terkirim!' : '⚠️ Teams gagal dikirim (cek webhook).'}`);
  } catch (err) {
    console.error("   ❌ Error kirim ke Teams:", err.message);
  }

  console.log("\n=================================================");
  console.log("🎉 TESTING SELESAI DENGAN SUKSES!");
  console.log("=================================================");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("❌ Fatal error saat testing:", err);
  process.exit(1);
});
