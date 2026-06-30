// src/usecases/forwardUnreadEmail.js
import { getLatestEmail } from "../infrastructure/gmail/gmailService.js";
import { sendIncidentAlert } from "../infrastructure/telegram/telegramService.js";
import { analyzeEmail } from "../infrastructure/ai/openaiService.js";
import { saveEmailLog } from "../database/supabase.js";

let lastEmailId = null;

// Daftar filter spam/newsletter
const senderBlacklist = ["newsletter@", "marketing@", "no-reply@", "noreply@"];
const subjectBlacklist = ["promo", "newsletter", "subscription"];

export async function forwardUnreadEmail(auth) {
  const email = await getLatestEmail(auth);

  if (!email) return;

  // Filter email tidak penting berdasarkan sender / subject
  const isSenderBlacklisted = senderBlacklist.some(item =>
    email.from.toLowerCase().includes(item)
  );
  const isSubjectBlacklisted = subjectBlacklist.some(item =>
    email.subject.toLowerCase().includes(item)
  );

  if (isSenderBlacklisted || isSubjectBlacklisted) {
    console.log(`⏩ Email dianggap spam/newsletter, skip: ${email.from} | ${email.subject}`);
    await saveEmailLog(email, { category: "Spam" }, false); // tetap simpan log
    return; // skip email ini
  }

  // Cegah memproses email yang sama dua kali
  if (email.id === lastEmailId) {
    console.log("⏩ Email sudah diproses, skip...");
    return;
  }
  lastEmailId = email.id;

  console.log("📩 EMAIL BARU:", email);

  // Analisis AI
  const analysis = await analyzeEmail(email);

  // Normalisasi category
  const category = (analysis.category || "").trim().toLowerCase();

  // Filter spam / promo / newsletter berdasarkan AI
  if (["spam", "newsletter", "promo"].includes(category)) {
    console.log(`⏩ Email dianggap tidak penting oleh AI, skip: ${email.from}`);
    await saveEmailLog(email, analysis, false); // tetap simpan log
    return; // jangan kirim Telegram
  }

  // Format pesan untuk Telegram
  const message = `
🚨 INCIDENT BARU

From:
${email.from}

Subject:
${email.subject}

Summary:
${analysis.summary}

Category:
${analysis.category}

Priority:
${analysis.priority}
`;

  // Kirim ke Telegram
  await sendIncidentAlert(email, analysis);

  // Simpan log email yang berhasil dikirim
  await saveEmailLog(email, analysis, true);
}
