// src/database/supabase.js
// ADAPTER MIGRATION: Seluruh operasi sekarang dialihkan ke PostgreSQL VPS lokal.

import { pgPool, pgEmitter } from "./postgres.js";
import { createClickUpTask } from "../infrastructure/clickup/clickupService.js";

export { pgPool, pgEmitter };

export async function isEmailProcessed(emailId) {
  const res = await pgPool.query(
    'SELECT id FROM public.intake_message WHERE idempotency_key = $1 OR source_ref = $1 LIMIT 1',
    [emailId]
  );
  return res.rows.length > 0;
}

// ====================== TICKET ID GENERATOR ======================
export async function generateTicketId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;

  try {
    const res = await pgPool.query(
      `SELECT ticket_id FROM public."Unified_Ticket_Tracker" 
       WHERE ticket_id LIKE $1 
       ORDER BY ticket_id DESC 
       LIMIT 1`,
      [`TCK-${dateStr}-%`]
    );

    let sequence = 1;
    if (res.rows.length > 0 && res.rows[0].ticket_id) {
      const lastSequence = parseInt(res.rows[0].ticket_id.split("-").pop(), 10);
      if (!isNaN(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }

    const newTicketId = `TCK-${dateStr}-${String(sequence).padStart(4, "0")}`;
    console.log(`🎫 Generated Ticket ID: ${newTicketId}`);
    return newTicketId;
  } catch (err) {
    console.error("❌ Error generate ticket_id:", err);
    return `TCK-${dateStr}-0001`;
  }
}

// ====================== SAVE TICKET ======================
export async function saveEmailLog(email, analysis = {}, telegramSent = false, telegramMessageId = null, telegramChatId = null) {
  try {
    const ticketId = email.ticket_id || email.id || (await generateTicketId());

    const payload = {
      ticket_id: ticketId,
      email_id: email.messageId || email.id || Date.now().toString(),
      from: email.from || null,
      subject: email.subject || null,
      body: email.body || null,
      summary: analysis.summary || null,
      category: analysis.category || "Incident Management",
      project: analysis.project || email.project || null,
      priority: analysis.priority || "MEDIUM",
      source: email.source || "whatsapp",
      group_id: email.group_id || null,
      telegram_sent: telegramSent,
      telegram_message_id: telegramMessageId ? String(telegramMessageId) : null,
      telegram_chat_id: telegramChatId ? String(telegramChatId) : null,
      intake_received_at: email.intake_received_at || (telegramSent ? new Date().toISOString() : null),
      status: telegramSent
        ? analysis.confidence_score !== undefined && Number(analysis.confidence_score) < 80
          ? "Pending Confirmation"
          : "In Progress"
        : "Logged (No Action)",
      processed_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    };

    const keys = Object.keys(payload);
    const values = Object.values(payload);
    const columns = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

    await pgPool.query(
      `INSERT INTO public."Unified_Ticket_Tracker" (${columns}) VALUES (${placeholders})`,
      values
    );

    await createClickUpTask(payload).catch((e) => console.error("ClickUp Task Error:", e.message));

    console.log(`🎫 Ticket berhasil disimpan ke PostgreSQL: ${ticketId}`);
    return ticketId;
  } catch (err) {
    console.error("❌ Unexpected error in saveEmailLog:", err.message);
    return null;
  }
}

// ====================== SAVE RAW TELEGRAM DM ======================
export async function saveRawTelegramDM(dmData) {
  try {
    const ticketId = await generateTicketId();

    const payload = {
      ticket_id: ticketId,
      email_id: `TG-DM-${dmData.messageId || Date.now()}`,
      from: dmData.senderPhone ? `${dmData.senderName} (${dmData.senderPhone})` : dmData.senderName,
      subject: `[DM Pribadi] Pesan dari ${dmData.senderName}`,
      body: dmData.messageText,
      summary: null,
      category: "Incident Management",
      priority: "MEDIUM",
      source: "telegram_personal",
      telegram_sent: false,
      telegram_message_id: null,
      telegram_chat_id: null,
      status: "In Progress",
      processed_at: dmData.timestamp || new Date().toISOString(),
    };

    const keys = Object.keys(payload);
    const values = Object.values(payload);
    const columns = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

    await pgPool.query(
      `INSERT INTO public."Unified_Ticket_Tracker" (${columns}) VALUES (${placeholders})`,
      values
    );

    console.log(`   🎫 Raw DM tersimpan ke PostgreSQL: ${ticketId}`);
    return { ticket_id: ticketId, ...payload };
  } catch (err) {
    console.error("❌ Unexpected error in saveRawTelegramDM:", err.message);
    return null;
  }
}

// ====================== UPDATE STATUS ======================
export async function updateIncidentStatus(telegramMessageId, newStatus) {
  if (!telegramMessageId) {
    console.warn("⚠️ telegramMessageId kosong, update status dibatalkan");
    return false;
  }

  try {
    const now = new Date().toISOString();
    let query;
    let params;

    if (["Done", "Resolved", "Cancelled"].includes(newStatus)) {
      query = `UPDATE public."Unified_Ticket_Tracker" 
               SET status = $1, updated_at = $2, resolved_at = $2 
               WHERE telegram_message_id = $3 RETURNING ticket_id`;
      params = [newStatus, now, String(telegramMessageId)];
    } else {
      query = `UPDATE public."Unified_Ticket_Tracker" 
               SET status = $1, updated_at = $2 
               WHERE telegram_message_id = $3 RETURNING ticket_id`;
      params = [newStatus, now, String(telegramMessageId)];
    }

    const res = await pgPool.query(query, params);
    if (res.rows.length === 0) {
      console.warn(`⚠️ Tidak ada tiket dengan telegram_message_id: ${telegramMessageId}`);
      return false;
    }

    console.log(`✅ Status tiket diubah menjadi "${newStatus}" (telegram_message_id: ${telegramMessageId})`);

    if (["Done", "Resolved", "Cancelled"].includes(newStatus)) {
      const ticketId = res.rows[0].ticket_id;
      await closeConversationSessionByTicket(ticketId).catch(() => {});
    }

    return true;
  } catch (err) {
    console.error(`❌ Gagal update status menjadi "${newStatus}":`, err.message);
    return false;
  }
}

export async function getTicketById(ticketId) {
  if (!ticketId) return null;
  try {
    const res = await pgPool.query(
      'SELECT * FROM public."Unified_Ticket_Tracker" WHERE ticket_id = $1 LIMIT 1',
      [ticketId.trim()]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error(`❌ Gagal mengambil ticket ${ticketId}:`, err.message);
    return null;
  }
}

export async function getTicketByReference(reference) {
  const clean = String(reference || "").trim().toUpperCase();
  if (!clean) return null;

  try {
    // 1. Exact ticket_id
    let res = await pgPool.query(
      'SELECT * FROM public."Unified_Ticket_Tracker" WHERE UPPER(ticket_id) = $1 LIMIT 1',
      [clean]
    );
    if (res.rows.length > 0) return { ...res.rows[0], _matched_by: "ticket_id_exact" };

    // 2. Numeric internal ID atau suffix
    if (/^\d+$/.test(clean)) {
      res = await pgPool.query(
        'SELECT * FROM public."Unified_Ticket_Tracker" WHERE id = $1 LIMIT 1',
        [parseInt(clean, 10)]
      );
      if (res.rows.length > 0) return { ...res.rows[0], _matched_by: "internal_id" };

      res = await pgPool.query(
        'SELECT * FROM public."Unified_Ticket_Tracker" WHERE ticket_id LIKE $1 LIMIT 2',
        [`%-${clean}`]
      );
      if (res.rows.length === 1) return { ...res.rows[0], _matched_by: "ticket_id_suffix" };
    }

    return null;
  } catch (err) {
    console.error("❌ Error in getTicketByReference:", err.message);
    return null;
  }
}

export async function updateTicket(ticketId, updateData) {
  if (!ticketId || !updateData || Object.keys(updateData).length === 0) return false;

  try {
    const payload = {
      ...updateData,
      updated_at: new Date().toISOString(),
    };
    if (updateData.status && ["Done", "Resolved"].includes(updateData.status)) {
      payload.resolved_at = new Date().toISOString();
    }

    const keys = Object.keys(payload);
    const values = Object.values(payload);
    const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(", ");

    values.push(ticketId);
    await pgPool.query(
      `UPDATE public."Unified_Ticket_Tracker" SET ${setClause} WHERE ticket_id = $${values.length}`,
      values
    );

    return true;
  } catch (err) {
    console.error(`❌ Gagal update ticket ${ticketId}:`, err.message);
    return false;
  }
}

export async function deleteTicket(ticketId) {
  if (!ticketId) return false;
  try {
    await pgPool.query('DELETE FROM public."Unified_Ticket_Tracker" WHERE ticket_id = $1', [ticketId]);
    return true;
  } catch (err) {
    console.error(`❌ Gagal menghapus ticket ${ticketId}:`, err.message);
    return false;
  }
}

export async function getTicketsByStatus(status = null) {
  try {
    if (status) {
      const res = await pgPool.query(
        'SELECT * FROM public."Unified_Ticket_Tracker" WHERE status = $1 ORDER BY processed_at DESC',
        [status]
      );
      return res.rows;
    }
    const res = await pgPool.query(
      'SELECT * FROM public."Unified_Ticket_Tracker" ORDER BY processed_at DESC'
    );
    return res.rows;
  } catch (err) {
    console.error("❌ Gagal mengambil tiket berdasarkan status:", err.message);
    return [];
  }
}

export async function getTicketsByDateRange(days = 7) {
  try {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const res = await pgPool.query(
      'SELECT * FROM public."Unified_Ticket_Tracker" WHERE processed_at >= $1 ORDER BY processed_at DESC',
      [fromDate.toISOString()]
    );
    return res.rows;
  } catch (err) {
    console.error(`❌ Gagal mengambil tiket ${days} hari terakhir:`, err.message);
    return [];
  }
}

export async function getTicketsByDate(dateStr, limit = 15) {
  try {
    const startWib = new Date(`${dateStr}T00:00:00+07:00`);
    const endWib = new Date(`${dateStr}T23:59:59+07:00`);

    const res = await pgPool.query(
      `SELECT ticket_id, subject, summary, priority, status, processed_at, "from", category 
       FROM public."Unified_Ticket_Tracker" 
       WHERE processed_at >= $1 AND processed_at <= $2 
       ORDER BY processed_at DESC 
       LIMIT $3`,
      [startWib.toISOString(), endWib.toISOString(), limit]
    );
    return res.rows;
  } catch (err) {
    console.error(`❌ Gagal mengambil tiket tanggal ${dateStr}:`, err.message);
    return [];
  }
}

export async function searchTickets(keyword) {
  if (!keyword?.trim()) return [];
  try {
    const searchTerm = `%${keyword.trim()}%`;
    const res = await pgPool.query(
      `SELECT * FROM public."Unified_Ticket_Tracker" 
       WHERE subject ILIKE $1 OR body ILIKE $1 OR summary ILIKE $1 OR "from" ILIKE $1 
       ORDER BY processed_at DESC 
       LIMIT 30`,
      [searchTerm]
    );
    return res.rows;
  } catch (err) {
    console.error("❌ Gagal mencari tiket:", err.message);
    return [];
  }
}

export async function getDailySummary() {
  const tickets = await getTicketsByDateRange(1);
  return {
    date: new Date().toISOString().split("T")[0],
    total: tickets.length,
    critical: tickets.filter((t) => t.priority === "CRITICAL").length,
    high: tickets.filter((t) => t.priority === "HIGH").length,
    inProgress: tickets.filter((t) => t.status === "In Progress").length,
    done: tickets.filter((t) => ["Done", "Resolved"].includes(t.status)).length,
  };
}

export async function findActiveTicketsForGroup(groupId, source) {
  try {
    const res = await pgPool.query(
      `SELECT * FROM public."Unified_Ticket_Tracker" 
       WHERE source = $1 
         AND status NOT IN ('Done','Resolved','Cancelled','No Action')
         AND telegram_chat_id LIKE $2 
       ORDER BY updated_at DESC 
       LIMIT 5`,
      [source, `%|${groupId}`]
    );
    return res.rows;
  } catch (err) {
    console.error(`❌ Error mencari tiket aktif grup (${groupId}):`, err.message);
    return [];
  }
}

export async function findActiveTicketForThreading(remoteJid, groupSubject, quotedStanzaId = null, source = "whatsapp") {
  try {
    if (quotedStanzaId) {
      const res = await pgPool.query(
        'SELECT * FROM public."Unified_Ticket_Tracker" WHERE email_id = $1 LIMIT 1',
        [quotedStanzaId]
      );
      if (res.rows.length > 0) {
        const ticket = res.rows[0];
        if (!["Done", "Resolved", "Cancelled"].includes(ticket.status)) {
          return ticket;
        }
      }
    }

    const conversationKey = `${source}_${remoteJid}`;
    const convRes = await pgPool.query(
      'SELECT ticket_id FROM public.conversation WHERE conversation_key = $1 AND status = $2 LIMIT 1',
      [conversationKey, "OPEN"]
    );

    if (convRes.rows.length > 0 && convRes.rows[0].ticket_id) {
      const activeTicketId = convRes.rows[0].ticket_id;
      const tRes = await pgPool.query(
        'SELECT * FROM public."Unified_Ticket_Tracker" WHERE ticket_id = $1 LIMIT 1',
        [activeTicketId]
      );
      if (tRes.rows.length > 0) {
        const ticket = tRes.rows[0];
        if (!["Done", "Resolved", "Cancelled"].includes(ticket.status)) {
          return ticket;
        }
      }
    }

    return null;
  } catch (err) {
    console.error("❌ Unexpected error in findActiveTicketForThreading:", err.message);
    return null;
  }
}

export async function appendMessageToTicket(ticketId, currentBody, senderName, text) {
  try {
    const timestamp = new Date().toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta",
    });

    const formattedAppend = `\n\n💬 [${timestamp} - ${senderName}]: ${text}`;
    const newBody = (currentBody || "") + formattedAppend;

    await pgPool.query(
      `UPDATE public."Unified_Ticket_Tracker" 
       SET body = $1, updated_at = NOW(), last_message_at = NOW() 
       WHERE ticket_id = $2`,
      [newBody, ticketId]
    );

    return true;
  } catch (err) {
    console.error("❌ Error in appendMessageToTicket:", err.message);
    return false;
  }
}

export async function createConversationSession(source, groupId, ticketId, lastMessage, summary = null) {
  const conversationKey = `${source}_${groupId}`;
  try {
    const now = new Date().toISOString();
    await pgPool.query(
      `INSERT INTO public.conversation (conversation_key, ticket_id, source_channel, group_id, status, last_message, last_message_at, summary)
       VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7)
       ON CONFLICT (conversation_key) DO UPDATE
       SET ticket_id = EXCLUDED.ticket_id,
           status = 'OPEN',
           last_message = EXCLUDED.last_message,
           last_message_at = EXCLUDED.last_message_at,
           summary = COALESCE(EXCLUDED.summary, public.conversation.summary)`,
      [conversationKey, ticketId, source, groupId, lastMessage, now, summary]
    );
    return true;
  } catch (err) {
    console.error("❌ Error in createConversationSession:", err.message);
    return false;
  }
}

export async function updateConversationLastMessage(source, groupId, lastMessage) {
  const conversationKey = `${source}_${groupId}`;
  try {
    await pgPool.query(
      `UPDATE public.conversation 
       SET last_message = $1, last_message_at = NOW() 
       WHERE conversation_key = $2 AND status = 'OPEN'`,
      [lastMessage, conversationKey]
    );
    return true;
  } catch (err) {
    console.error("❌ Error in updateConversationLastMessage:", err.message);
    return false;
  }
}

export async function closeConversationSessionByTicket(ticketId) {
  try {
    await pgPool.query(
      `UPDATE public.conversation SET status = 'CLOSED' WHERE ticket_id = $1`,
      [ticketId]
    );
    return true;
  } catch (err) {
    console.error("❌ Error in closeConversationSessionByTicket:", err.message);
    return false;
  }
}

export async function saveRawEmail(email) {
  try {
    const payload = {
      source_channel: "email",
      source_ref: email.id,
      sender: email.from,
      thread_ref: email.threadId,
      received_at: email.date ? new Date(email.date).toISOString() : new Date().toISOString(),
      body_text: email.body,
      attachments: JSON.stringify({ count: email.attachmentCount }),
      raw_payload: JSON.stringify(email),
      idempotency_key: `email-${email.id}`,
      status: "pending",
    };

    const keys = Object.keys(payload);
    const values = Object.values(payload);
    const columns = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

    const res = await pgPool.query(
      `INSERT INTO public.intake_message (${columns}) 
       VALUES (${placeholders}) 
       ON CONFLICT (idempotency_key) DO NOTHING 
       RETURNING *`,
      values
    );

    return res.rows[0] || null;
  } catch (err) {
    console.error("❌ Error in saveRawEmail:", err.message);
    return null;
  }
}

export async function saveRawIntakeMessage(data) {
  try {
    let sourceChannel = data.source_channel || "wa_group";
    if (sourceChannel === "whatsapp") sourceChannel = "wa_group";
    if (sourceChannel === "telegram_group" || sourceChannel === "telegram_personal") sourceChannel = "telegram";

    const payload = {
      source_channel: sourceChannel,
      source_ref: data.source_ref || null,
      sender: data.sender || null,
      thread_ref: data.thread_ref || null,
      received_at: data.received_at || new Date().toISOString(),
      body_text: data.body_text || null,
      attachments: data.attachments || data.attachment ? JSON.stringify(data.attachments || data.attachment) : null,
      raw_payload: data.raw_payload ? JSON.stringify(data.raw_payload) : null,
      idempotency_key: data.idempotency_key || data.idempotency_ref || null,
      status: "pending",
    };

    const keys = Object.keys(payload);
    const values = Object.values(payload);
    const columns = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");

    const res = await pgPool.query(
      `INSERT INTO public.intake_message (${columns}) 
       VALUES (${placeholders}) 
       ON CONFLICT (idempotency_key) DO NOTHING 
       RETURNING id, source_channel, source_ref, sender`,
      values
    );

    if (res.rows.length === 0) {
      console.warn(`⚠️ Pesan duplikat (idempotency_key: ${payload.idempotency_key}) dilewati`);
      return null;
    }

    const inserted = res.rows[0];
    console.log(`   📥 Raw message tersimpan ke PostgreSQL (id: ${inserted?.id})`);
    return inserted;
  } catch (err) {
    console.error("❌ Error in saveRawIntakeMessage:", err.message);
    return null;
  }
}

export async function getRawIntakeMessageById(rawId) {
  try {
    const res = await pgPool.query(
      "SELECT * FROM public.intake_message WHERE id = $1 LIMIT 1",
      [rawId]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error(`❌ Gagal mengambil intake_message ID ${rawId}:`, err.message);
    return null;
  }
}

export async function markRawMessageAs(rawId, status, ticketId = null, ignoreReason = null) {
  try {
    await pgPool.query(
      `UPDATE public.intake_message 
       SET status = $1, ticket_id = $2, processed_at = NOW(), ignore_reason = $3 
       WHERE id = $4`,
      [status, ticketId, ignoreReason, rawId]
    );
    return true;
  } catch (err) {
    console.error(`❌ Gagal markRawMessageAs (id: ${rawId}):`, err.message);
    return false;
  }
}

export async function findActiveTicketsByGroupId(groupId, source = null) {
  try {
    let query = `
      SELECT * FROM public."Unified_Ticket_Tracker"
      WHERE group_id = $1 
        AND status NOT IN ('Done','Resolved','Cancelled','No Action','Logged (No Action)')
    `;
    const params = [groupId];

    if (source) {
      params.push(source);
      query += ` AND source = $${params.length}`;
    }

    query += ` ORDER BY last_message_at DESC NULLS LAST, processed_at DESC LIMIT 5`;

    const res = await pgPool.query(query, params);
    return res.rows;
  } catch (err) {
    console.error(`❌ Error findActiveTicketsByGroupId:`, err.message);
    return [];
  }
}

export async function getPendingRawMessages(limit = 50) {
  try {
    const res = await pgPool.query(
      `SELECT * FROM public.intake_message WHERE status = 'pending' ORDER BY received_at ASC LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error("❌ Error in getPendingRawMessages:", err.message);
    return [];
  }
}

export async function getTicketsNeedingSlaCheck() {
  try {
    const res = await pgPool.query(
      `SELECT ticket_id, "from", subject, priority, severity, category, confirmed_at, sla_warned, sla_alerted, sla_deadline_minutes, telegram_chat_id, telegram_message_id
       FROM public."Unified_Ticket_Tracker"
       WHERE status = 'In Progress' 
         AND confirmed_at IS NOT NULL 
         AND sla_alerted = false
       ORDER BY confirmed_at ASC`
    );
    return res.rows;
  } catch (err) {
    console.error("❌ SLA check query error:", err.message);
    return [];
  }
}

export async function markSlaFlag(ticketId, level) {
  try {
    const field = level === "warn" ? "sla_warned" : "sla_alerted";
    await pgPool.query(
      `UPDATE public."Unified_Ticket_Tracker" SET "${field}" = true WHERE ticket_id = $1`,
      [ticketId]
    );
    return true;
  } catch (err) {
    console.error(`❌ Gagal set SLA flag [${level}] tiket ${ticketId}:`, err.message);
    return false;
  }
}

export async function getTicketsNeedingConfirmationCheck() {
  try {
    const res = await pgPool.query(
      `SELECT ticket_id, "from", subject, priority, severity, intake_received_at, confirmed_at, processed_at, created_at, sla_confirm_warned, sla_confirm_last_warned_at, sla_confirm_alerted, telegram_chat_id, telegram_message_id
       FROM public."Unified_Ticket_Tracker"
       WHERE status <> 'Done'
         AND (intake_received_at IS NOT NULL OR confirmed_at IS NOT NULL OR processed_at IS NOT NULL OR created_at IS NOT NULL)
       ORDER BY intake_received_at ASC NULLS LAST`
    );
    return res.rows;
  } catch (err) {
    console.error("❌ SLA Konfirmasi check query error:", err.message);
    return [];
  }
}

export async function markSlaConfirmFlag(ticketId, level) {
  try {
    if (level === "warn") {
      await pgPool.query(
        `UPDATE public."Unified_Ticket_Tracker" 
         SET sla_confirm_warned = true, sla_confirm_last_warned_at = NOW() 
         WHERE ticket_id = $1`,
        [ticketId]
      );
    } else {
      await pgPool.query(
        `UPDATE public."Unified_Ticket_Tracker" SET sla_confirm_alerted = true WHERE ticket_id = $1`,
        [ticketId]
      );
    }
    return true;
  } catch (err) {
    console.error(`❌ Gagal set SLA Konfirmasi flag [${level}] tiket ${ticketId}:`, err.message);
    return false;
  }
}

export async function getPendingIntakesNeedingConfirmationCheck() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await pgPool.query(
      `SELECT id, source_channel, sender, body_text, raw_payload, received_at, status
       FROM public.intake_message
       WHERE status = 'pending' AND received_at >= $1
       ORDER BY received_at ASC`,
      [cutoff]
    );
    return res.rows;
  } catch (err) {
    console.error("❌ Error fetching pending intakes for SLA check:", err.message);
    return [];
  }
}

export async function markIntakeSlaConfirmFlag(intakeId, level) {
  try {
    const res = await pgPool.query(
      "SELECT raw_payload FROM public.intake_message WHERE id = $1 LIMIT 1",
      [intakeId]
    );
    const currentPayload = res.rows[0]?.raw_payload || {};
    const parsed = typeof currentPayload === "string" ? JSON.parse(currentPayload) : currentPayload;

    const updatePayload =
      level === "warn"
        ? { ...parsed, sla_confirm_warned: true, sla_confirm_last_warned_at: new Date().toISOString() }
        : { ...parsed, sla_confirm_alerted: true };

    await pgPool.query(
      "UPDATE public.intake_message SET raw_payload = $1 WHERE id = $2",
      [JSON.stringify(updatePayload), intakeId]
    );
    return true;
  } catch (err) {
    console.error("❌ Unexpected error in markIntakeSlaConfirmFlag:", err.message);
    return false;
  }
}

// Kompatibilitas query helper untuk OpenAI service jika dibutuhkan
export const supabase = {
  from(tableName) {
    return {
      select(cols = "*", opts = {}) {
        let whereClauses = [];
        let params = [];
        let orderClause = "";
        let limitClause = "";

        const queryObj = {
          eq(col, val) {
            params.push(val);
            whereClauses.push(`"${col}" = $${params.length}`);
            return queryObj;
          },
          ilike(col, val) {
            params.push(val);
            whereClauses.push(`"${col}" ILIKE $${params.length}`);
            return queryObj;
          },
          gte(col, val) {
            params.push(val);
            whereClauses.push(`"${col}" >= $${params.length}`);
            return queryObj;
          },
          lte(col, val) {
            params.push(val);
            whereClauses.push(`"${col}" <= $${params.length}`);
            return queryObj;
          },
          is(col, val) {
            if (val === null) {
              whereClauses.push(`"${col}" IS NULL`);
            } else {
              params.push(val);
              whereClauses.push(`"${col}" = $${params.length}`);
            }
            return queryObj;
          },
          not(col, operator, val) {
            if (operator === "is" && val === null) {
              whereClauses.push(`"${col}" IS NOT NULL`);
            } else if (operator === "in") {
              whereClauses.push(`"${col}" NOT IN ${val}`);
            } else {
              params.push(val);
              whereClauses.push(`"${col}" <> $${params.length}`);
            }
            return queryObj;
          },
          or(clauseStr) {
            return queryObj;
          },
          order(col, { ascending = true } = {}) {
            orderClause = `ORDER BY "${col}" ${ascending ? "ASC" : "DESC"}`;
            return queryObj;
          },
          limit(n) {
            limitClause = `LIMIT ${parseInt(n, 10)}`;
            return queryObj;
          },
          async then(resolve, reject) {
            try {
              let sql = `SELECT ${cols} FROM public."${tableName}"`;
              if (whereClauses.length > 0) sql += ` WHERE ${whereClauses.join(" AND ")}`;
              if (orderClause) sql += ` ${orderClause}`;
              if (limitClause) sql += ` ${limitClause}`;

              const res = await pgPool.query(sql, params);
              resolve({ data: res.rows, error: null, count: res.rows.length });
            } catch (err) {
              console.error("❌ Postgres Query Error in AI helper:", err.message);
              resolve({ data: null, error: err, count: 0 });
            }
          },
        };
        return queryObj;
      },
    };
  },
};
