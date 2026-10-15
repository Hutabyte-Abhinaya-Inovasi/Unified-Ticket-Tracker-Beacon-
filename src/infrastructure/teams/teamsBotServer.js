// src/infrastructure/teams/teamsBotServer.js

import express from "express";
import {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
  ActivityTypes,
  MessageFactory,
} from "botbuilder";
import { env } from "../../config/env.js";
import { chatWithAI } from "../ai/openaiService.js";
import { getTicketById, searchTickets, updateIncidentStatus } from "../../database/supabase.js";

let serverInstance = null;

/**
 * Inisialisasi dan jalankan HTTP Server untuk Microsoft Teams Bot (Hutabot AI)
 */
export function startTeamsBotServer() {
  if (!env.MICROSOFT_APP_ID || !env.MICROSOFT_APP_PASSWORD) {
    console.warn("[Teams Bot] ⚠️ MICROSOFT_APP_ID atau MICROSOFT_APP_PASSWORD belum di-set di .env. Teams Bot Server tidak dijalankan.");
    return null;
  }

  const app = express();
  app.use(express.json());

  // Inisialisasi Autentikasi Bot Framework
  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: env.MICROSOFT_APP_ID,
    MicrosoftAppPassword: env.MICROSOFT_APP_PASSWORD,
    MicrosoftAppType: env.MICROSOFT_APP_TYPE || "SingleTenant",
    MicrosoftAppTenantId: env.MICROSOFT_APP_TENANT_ID || "e66d53eb-7157-4115-a05e-f14a6c7a432b",
  });

  const botFrameworkAuthentication = createBotFrameworkAuthenticationFromConfiguration(null, credentialsFactory);
  const adapter = new CloudAdapter(botFrameworkAuthentication);

  // Error Handler
  adapter.onTurnError = async (context, error) => {
    console.error("[Teams Bot] ❌ Error pada bot turn:", error);
    try {
      await context.sendActivity("⚠️ Maaf, terjadi kendala teknis saat memproses pesan di Hutabot AI.");
    } catch (_) {}
  };

  // Route Health Check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", bot: "Hutabot AI", timestamp: new Date().toISOString() });
  });

  app.get("/api/messages", (req, res) => {
    res.json({
      status: "ready",
      message: "Hutabot AI Messaging Endpoint is active. Send POST requests from Microsoft Teams.",
    });
  });

  // Route khusus untuk Power Automate / Workflows
  app.post("/api/workflows", async (req, res) => {
    try {
      const rawText = req.body?.text || req.body?.message || "";
      const sender = req.body?.sender || "Teams User";
      const cleanText = rawText.replace(/<[^>]*>/g, "").trim();

      if (!cleanText) {
        return res.json({ reply: "Halo! Ketik `/help` atau `/ai [pertanyaan]` untuk berinteraksi." });
      }

      console.log(`[Workflows API] 📩 Menerima dari ${sender}: "${cleanText}"`);
      const reply = await processCommandText(cleanText);
      return res.json({ reply: reply || "AI tidak memberikan respon." });
    } catch (err) {
      console.error("[Workflows API] Error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // Main Endpoint Messaging dari Microsoft Teams
  app.post("/api/messages", async (req, res) => {
    await adapter.process(req, res, async (context) => {
      // 1. Tangani Pesan Teks (Message)
      if (context.activity.type === ActivityTypes.Message) {
        await handleIncomingMessage(context);
      }
      // 2. Tangani Klik Tombol dari Adaptive Card
      else if (context.activity.type === ActivityTypes.Invoke) {
        await handleCardInvoke(context);
      }
    });
  });

  const port = env.TEAMS_BOT_PORT || 3978;
  serverInstance = app.listen(port, "127.0.0.1", () => {
    console.log(`🤖 [Teams Bot] Server aktif mendengarkan di 127.0.0.1:${port}`);
    console.log(`🔗 [Teams Bot] Endpoint siap di: https://hutabyte.com/api/messages`);
  });

  return serverInstance;
}

/**
 * Tangani pesan masuk dari pengguna di grup atau personal chat Teams
 */
async function handleIncomingMessage(context) {
  const rawText = context.activity.text || "";

  // Hapus tag mention Teams seperti <at>Hutabot AI</at>
  const cleanText = rawText.replace(/<at>.*?<\/at>/gi, "").trim();

  if (!cleanText) {
    await context.sendActivity("Halo! Saya **Hutabot AI**. Ketik `/help` atau tanyakan sesuatu untuk memulai.");
    return;
  }

  console.log(`[Teams Bot] 📩 Pesan diterima dari ${context.activity.from?.name}: "${cleanText}"`);

  // Kirim indikator typing bahwa bot sedang berpikir
  await context.sendActivities([{ type: ActivityTypes.Typing }]);

  const lowerText = cleanText.toLowerCase();

  // ── COMMAND: /help atau /menu ───────────────────────────────────────────
  if (lowerText === "/help" || lowerText === "/menu" || lowerText === "help") {
    const helpCard = {
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          text: "🤖 **Menu Bantuan Hutabot AI (Beacon)**",
          weight: "Bolder",
          size: "Medium",
          color: "Accent",
        },
        {
          type: "TextBlock",
          text: "Berikut perintah dan interaksi yang dapat Anda gunakan di Teams:",
          wrap: true,
        },
        {
          type: "FactSet",
          facts: [
            { title: "💬 Tanya AI:", value: "Ketik `@Hutabot AI [pertanyaan]` atau `/ai [pertanyaan]`" },
            { title: "🎫 Cek Tiket:", value: "`/status <ticket_id>` (contoh: `/status TCK-20261013-0011`)" },
            { title: "🔍 Cari Tiket:", value: "`/cari <kata_kunci>` (contoh: `/cari mediation`)" },
            { title: "📋 Bantuan:", value: "`/help` untuk membuka menu ini" },
          ],
        },
      ],
    };

    const reply = MessageFactory.attachment({
      contentType: "application/vnd.microsoft.card.adaptive",
      content: helpCard,
    });

    await context.sendActivity(reply);
    return;
  }

  // ── COMMAND: /status <ticket_id> ─────────────────────────────────────────
  if (lowerText.startsWith("/status")) {
    const parts = cleanText.split(" ");
    const ticketId = parts[1]?.trim();

    if (!ticketId) {
      await context.sendActivity("⚠️ Harap cantumkan Ticket ID. Contoh: `/status TCK-20261013-0011`");
      return;
    }

    try {
      const ticket = await getTicketById(ticketId);
      if (!ticket) {
        await context.sendActivity(`❌ Tiket dengan ID \`${ticketId}\` tidak ditemukan.`);
        return;
      }

      const statusCard = {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          {
            type: "TextBlock",
            text: `🎫 **Detail Tiket: ${ticket.ticket_id}**`,
            weight: "Bolder",
            size: "Medium",
            color: "Accent",
          },
          {
            type: "FactSet",
            facts: [
              { title: "📌 Status:", value: ticket.status || "-" },
              { title: "⚡ Severity:", value: (ticket.severity || ticket.priority || "-").toUpperCase() },
              { title: "📂 Project:", value: ticket.project || "-" },
              { title: "📝 Subjek:", value: ticket.subject || "-" },
              { title: "👤 PIC:", value: ticket.pic || ticket.operator_name || "Belum ada" },
            ],
          },
        ],
      };

      await context.sendActivity(
        MessageFactory.attachment({
          contentType: "application/vnd.microsoft.card.adaptive",
          content: statusCard,
        })
      );
    } catch (err) {
      console.error("[Teams Bot] Error cek status tiket:", err.message);
      await context.sendActivity("❌ Terjadi kesalahan saat mengambil data tiket dari database.");
    }
    return;
  }

  // ── COMMAND: /cari <query> ──────────────────────────────────────────────
  if (lowerText.startsWith("/cari") || lowerText.startsWith("/search")) {
    const query = cleanText.replace(/^\/(cari|search)\s*/i, "").trim();
    if (!query) {
      await context.sendActivity("⚠️ Harap masukkan kata kunci pencarian. Contoh: `/cari mediation`");
      return;
    }

    try {
      const results = await searchTickets(query);
      if (!results || results.length === 0) {
        await context.sendActivity(`🔍 Tidak ditemukan tiket dengan kata kunci: **"${query}"**`);
        return;
      }

      const top5 = results.slice(0, 5);
      const listText = top5
        .map((t) => `• \`${t.ticket_id}\` [${t.status}] - **${t.subject || "No Subject"}**`)
        .join("\n");

      await context.sendActivity(
        `🔍 **Hasil Pencarian untuk "${query}":**\n\n${listText}\n\n_Gunakan \`/status <ticket_id>\` untuk melihat rincian._`
      );
    } catch (err) {
      console.error("[Teams Bot] Error search tickets:", err.message);
      await context.sendActivity("❌ Gagal mencari tiket.");
    }
    return;
  }

  // ── TANYA AI (Default jika /ai atau pertanyaan bebas) ───────────────────
  let promptText = cleanText;
  if (lowerText.startsWith("/ai")) {
    promptText = cleanText.replace(/^\/ai\s*/i, "").trim();
  }

  try {
    console.log(`[Teams Bot] 🤖 Memanggil AI untuk prompt: "${promptText.substring(0, 50)}..."`);
    const aiResponse = await chatWithAI(promptText);

    await context.sendActivity(aiResponse || "AI tidak memberikan respon.");
  } catch (err) {
    console.error("[Teams Bot] Error chatWithAI:", err.message);
    await context.sendActivity("⚠️ Maaf, terjadi kesalahan saat menghubungi layanan AI.");
  }
}

/**
 * Logika pemroses perintah untuk Teams Bot dan Workflows
 */
export async function processCommandText(cleanText) {
  const lower = cleanText.toLowerCase();

  if (lower === "/help" || lower === "/menu" || lower === "help") {
    return "🤖 **Menu Bantuan Hutabot AI (Beacon)**\n\n• `💬 /ai <pertanyaan>` : Tanya AI & Panduan Troubleshooting\n• `🎫 /status <ticket_id>` : Cek status & detail tiket\n• `🔍 /cari <kata_kunci>` : Cari tiket berdasarkan subjek/deskripsi\n• `📋 /help` : Buka menu bantuan ini";
  }

  if (lower.startsWith("/status")) {
    const parts = cleanText.split(" ");
    const ticketId = parts[1]?.trim();
    if (!ticketId) return "⚠️ Harap cantumkan Ticket ID. Contoh: `/status TCK-20261013-0011`";
    const ticket = await getTicketById(ticketId);
    if (!ticket) return `❌ Tiket dengan ID \`${ticketId}\` tidak ditemukan.`;
    return `🎫 **Detail Tiket: ${ticket.ticket_id}**\n• Status: **${ticket.status || "-"}**\n• Severity: **${(ticket.severity || ticket.priority || "-").toUpperCase()}**\n• Project: **${ticket.project || "-"}**\n• Subjek: ${ticket.subject || "-"}\n• PIC: ${ticket.pic || ticket.operator_name || "Belum ada"}`;
  }

  if (lower.startsWith("/cari") || lower.startsWith("/search")) {
    const query = cleanText.replace(/^\/(cari|search)\s*/i, "").trim();
    if (!query) return "⚠️ Harap masukkan kata kunci. Contoh: `/cari mediation`";
    const results = await searchTickets(query);
    if (!results || results.length === 0) return `🔍 Tidak ditemukan tiket dengan kata kunci: **"${query}"**`;
    const top5 = results.slice(0, 5);
    const listText = top5.map((t) => `• \`${t.ticket_id}\` [${t.status}] - **${t.subject || "No Subject"}**`).join("\n");
    return `🔍 **Hasil Pencarian "${query}":**\n\n${listText}\n\n_Gunakan \`/status <ticket_id>\` untuk melihat rincian._`;
  }

  let prompt = cleanText;
  if (lower.startsWith("/ai")) {
    prompt = cleanText.replace(/^\/ai\s*/i, "").trim();
  }
  return await chatWithAI(prompt);
}

/**
 * Tangani interaksi kartu (tombol Adaptive Card yang diklik)
 */
async function handleCardInvoke(context) {
  const actionData = context.activity.value?.action || context.activity.value;
  console.log("[Teams Bot] 🔘 Card action invoke diterima:", actionData);

  if (actionData?.action === "confirm_ticket" && actionData.ticketId) {
    await updateIncidentStatus(actionData.ticketId, "In Progress");
    await context.sendActivity(`✅ Tiket **${actionData.ticketId}** berhasil dikonfirmasi menjadi *In Progress* oleh ${context.activity.from?.name}!`);
  }
}

// Izinkan file ini dijalankan langsung untuk testing standalone: node src/infrastructure/teams/teamsBotServer.js
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("teamsBotServer.js")) {
  startTeamsBotServer();
}

