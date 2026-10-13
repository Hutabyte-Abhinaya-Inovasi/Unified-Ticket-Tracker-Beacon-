// src/infrastructure/teams/teamsService.js

import { env } from "../../config/env.js";

/**
 * Kirim payload Adaptive Card ke Microsoft Teams Webhook.
 * @param {Array} cardBody - Array elemen Adaptive Card (TextBlock, FactSet, Container, dll)
 * @param {string} summary - Ringkasan singkat untuk notifikasi pop-up
 */
export async function sendTeamsAdaptiveCard(cardBody, summary = "Beacon Notification") {
  const webhookUrl = env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[Teams] TEAMS_WEBHOOK_URL belum diset di .env. Pengiriman Teams dilewati.");
    return false;
  }

  const payload = {
    type: "message",
    summary: summary,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: cardBody,
        },
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 200 || res.status === 202) {
      console.log(`[Teams] ✅ Pesan berhasil dikirim ke Teams (HTTP ${res.status})`);
      return true;
    } else {
      const errText = await res.text();
      console.error(`[Teams] ❌ Gagal mengirim pesan ke Teams (HTTP ${res.status}):`, errText);
      return false;
    }
  } catch (err) {
    console.error("[Teams] ❌ Error saat fetch ke TEAMS_WEBHOOK_URL:", err.message);
    return false;
  }
}

/**
 * Format dan kirim Alert SLA ke Microsoft Teams.
 * Mendukung jenis:
 * - 'confirm_warn': Peringatan 9 menit belum konfirmasi
 * - 'confirm_alert': Alarm 15 menit habis belum konfirmasi
 * - 'work_warn': Peringatan sisa waktu SLA pengerjaan
 * - 'work_alert': Alarm SLA pengerjaan habis + eskalasi
 */
export async function sendTeamsSlaAlert({
  type,
  ticketId,
  severity = "MEDIUM",
  subject = "-",
  elapsedMin,
  limitMin,
  sisaMenit,
}) {
  const sevUpper = String(severity || "MEDIUM").toUpperCase();

  let headerTitle = "⚠️ PERINGATAN SLA BEACON";
  let headerColor = "Warning"; // 'Good' | 'Warning' | 'Attention' | 'Default'
  let description = "";
  const facts = [
    { title: "🎫 Ticket ID:", value: ticketId || "-" },
    { title: "📌 Severity:", value: sevUpper },
    { title: "📝 Subjek:", value: subject || "-" },
  ];

  if (type === "confirm_warn") {
    headerTitle = "⏰ PERINGATAN SLA KONFIRMASI";
    headerColor = "Warning";
    description = `Tiket ini **belum dikonfirmasi** selama ${Math.round(elapsedMin)} menit. Sisa waktu konfirmasi adalah **${sisaMenit} menit lagi**.`;
    facts.push(
      { title: "⏳ Sudah Menunggu:", value: `${Math.round(elapsedMin)} menit` },
      { title: "⏱ Sisa Waktu:", value: `${sisaMenit} menit lagi` }
    );
  } else if (type === "confirm_alert") {
    headerTitle = "🚨 SLA KONFIRMASI HABIS — TIKET BELUM DIKONFIRMASI!";
    headerColor = "Attention";
    description = `Tiket ini **belum dikonfirmasi** melebihi batas waktu konfirmasi (**${Math.round(elapsedMin)} menit**). Mohon segera ditindaklanjuti.`;
    facts.push(
      { title: "⏱ Waktu Tunggu:", value: `${Math.round(elapsedMin)} menit` },
      { title: "⚠️ Status:", value: "Pending Confirmation (Exceeded)" }
    );
  } else if (type === "work_warn") {
    headerTitle = "⚠️ PERINGATAN SLA PEKERJAAN";
    headerColor = "Warning";
    description = `Tiket sedang dalam pengerjaan dan mendekati batas waktu SLA. Sisa waktu penanganan adalah **${sisaMenit} menit lagi**.`;
    facts.push(
      { title: "⏱ Batas SLA:", value: `${limitMin} menit` },
      { title: "⏳ Sisa Waktu:", value: `${sisaMenit} menit lagi` }
    );
  } else if (type === "work_alert") {
    headerTitle = "🚨 INFORMASI URGENT — SLA PEKERJAAN HABIS!";
    headerColor = "Attention";
    description = `Tiket ini **melebihi batas waktu SLA (${limitMin} menit)**. Sistem telah melakukan **eskalasi otomatis** ke Head / Service Lead.`;
    facts.push(
      { title: "⏱ Batas SLA:", value: `${limitMin} menit (Habis)` },
      { title: "📢 Eskalasi:", value: "Otomatis ke Head / Service Lead" }
    );
  }

  const cardBody = [
    {
      type: "TextBlock",
      text: headerTitle,
      weight: "Bolder",
      size: "Medium",
      color: headerColor,
    },
    {
      type: "TextBlock",
      text: description,
      wrap: true,
      spacing: "Small",
    },
    {
      type: "FactSet",
      facts: facts,
      spacing: "Medium",
    },
  ];

  return await sendTeamsAdaptiveCard(cardBody, headerTitle);
}

/**
 * Format dan kirim notifikasi Tiket Baru / Kandidat Tiket ke Teams.
 */
export async function sendTeamsTicketAlert({
  ticketId,
  subject,
  severity = "MEDIUM",
  project = "-",
  sourceChannel = "-",
  sender = "-",
  summary = "",
}) {
  const cardBody = [
    {
      type: "TextBlock",
      text: "📥 TIKET BARU DITERIMA",
      weight: "Bolder",
      size: "Medium",
      color: "Accent",
    },
    {
      type: "TextBlock",
      text: summary || `Tiket baru telah dibuat dari channel **${sourceChannel}**.`,
      wrap: true,
      spacing: "Small",
    },
    {
      type: "FactSet",
      facts: [
        { title: "🎫 Ticket ID:", value: ticketId || "-" },
        { title: "📌 Severity:", value: String(severity).toUpperCase() },
        { title: "📂 Project:", value: project || "-" },
        { title: "👤 Pengirim:", value: sender || "-" },
        { title: "📡 Channel:", value: sourceChannel || "-" },
        { title: "📝 Subjek:", value: subject || "-" },
      ],
      spacing: "Medium",
    },
  ];

  return await sendTeamsAdaptiveCard(cardBody, `Tiket Baru: ${ticketId}`);
}
