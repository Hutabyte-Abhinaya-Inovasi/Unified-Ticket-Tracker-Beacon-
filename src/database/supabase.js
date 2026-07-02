// src/database/supabase.js

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { env } from '../config/env.js';

// Polyfill WebSocket untuk Node.js < 22 agar Supabase Realtime berfungsi
globalThis.WebSocket = WebSocket;

// Inisialisasi Supabase Client (gunakan service_role key untuk backend)
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// ====================== TICKET ID GENERATOR ======================
/**
 * Generate Ticket ID dengan format: INC-YYYYMMDD-XXXX
 * Contoh: INC-20260430-0001
 */
export async function generateTicketId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  try {
    const { data, error } = await supabase
      .from('Unified_Ticket_Tracker')
      .select('ticket_id')
      .like('ticket_id', `TCK-${dateStr}-%`)
      .order('ticket_id', { ascending: false })
      .limit(1);

    if (error) {
      console.error("❌ Error generate ticket_id:", error.message);
      return `TCK-${dateStr}-0001`; // Fallback
    }

    let sequence = 1;

    if (data && data.length > 0 && data[0].ticket_id) {
      const lastSequence = parseInt(data[0].ticket_id.split('-').pop(), 10);
      if (!isNaN(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }

    const newTicketId = `TCK-${dateStr}-${String(sequence).padStart(4, '0')}`;
    console.log(`✅ Generated Ticket ID: ${newTicketId}`);
    return newTicketId;

  } catch (err) {
    console.error("❌ Unexpected error in generateTicketId:", err);
    return `TCK-${dateStr}-0001`;
  }
}

// ====================== SAVE TICKET ======================
/**
 * Menyimpan laporan incident baru ke database
 */
export async function saveEmailLog(email, analysis = {}, telegramSent = false, telegramMessageId = null, telegramChatId = null) {
  try {
    // Gunakan ticket_id yang sudah digenerate (jika ada)
    const ticketId = email.ticket_id || email.id || await generateTicketId();

    const payload = {
      ticket_id: ticketId,
      email_id: email.messageId || email.id || Date.now().toString(),
      from: email.from || null,
      subject: email.subject || null,
      body: email.body || null,
      summary: analysis.summary || null,
      category: analysis.category || "Incident Management",
      priority: analysis.priority || "MEDIUM",
      source: email.source || "whatsapp",
      telegram_sent: telegramSent,
      telegram_message_id: telegramMessageId,
      telegram_chat_id: telegramChatId,
      status: telegramSent
        ? (analysis.confidence_score !== undefined && Number(analysis.confidence_score) < 80 ? "Pending Confirmation" : "In Progress")
        : "Logged (No Action)",
      processed_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('Unified_Ticket_Tracker')
      .insert([payload]);

    if (error) {
      console.error("❌ Gagal menyimpan ticket:", error.message);
      console.error("Payload:", payload);
      return null;
    }

    console.log(`✅ Ticket berhasil disimpan: ${ticketId}`);
    return ticketId;

  } catch (err) {
    console.error("❌ Unexpected error in saveEmailLog:", err.message);
    return null;
  }
}
// ====================== UPDATE STATUS ======================
/**
 * Update status tiket berdasarkan telegram_message_id
 */
export async function updateIncidentStatus(telegramMessageId, newStatus) {
  if (!telegramMessageId) {
    console.warn("⚠️ telegramMessageId kosong, update status dibatalkan");
    return false;
  }

  const updateData = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };

  if (["Done", "Resolved", "Cancelled"].includes(newStatus)) {
    updateData.resolved_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('Unified_Ticket_Tracker')
    .update(updateData)
    .eq('telegram_message_id', telegramMessageId);

  if (error) {
    console.error(`❌ Gagal update status menjadi "${newStatus}":`, error.message);
    return false;
  }

  console.log(`✅ Status tiket diubah menjadi "${newStatus}" (telegram_message_id: ${telegramMessageId})`);

  // Jika tiket selesai/dibatalkan, tutup sesi percakapannya di tabel conversation
  if (["Done", "Resolved", "Cancelled"].includes(newStatus)) {
    try {
      const { data, error: fetchError } = await supabase
        .from('Unified_Ticket_Tracker')
        .select('ticket_id')
        .eq('telegram_message_id', telegramMessageId)
        .limit(1);

      if (data && data.length > 0) {
        const ticketId = data[0].ticket_id;
        await closeConversationSessionByTicket(ticketId);
      }
    } catch (err) {
      console.error("⚠️ Gagal menutup sesi conversation saat update status:", err.message);
    }
  }

  return true;
}

export async function getTicketById(ticketId) {
  if (!ticketId) {
    console.warn("⚠️ ticketId kosong");
    return null;
  }

  const { data, error } = await supabase
    .from('Unified_Ticket_Tracker')
    .select('*')
    .eq('ticket_id', ticketId)
    .single();   // .single() karena hanya 1 record

  if (error) {
    if (error.code === 'PGRST116') {
      console.warn(`⚠️ Ticket dengan ID ${ticketId} tidak ditemukan`);
      return null;
    }
    console.error(`❌ Gagal mengambil ticket ${ticketId}:`, error.message);
    return null;
  }

  return data;
}

/**
 * Update tiket secara umum (bisa update beberapa field sekaligus)
 */
export async function updateTicket(ticketId, updateData) {
  if (!ticketId || !updateData || Object.keys(updateData).length === 0) {
    console.warn("⚠️ Data update tidak valid");
    return false;
  }

  // Tambahkan timestamp update otomatis
  const payload = {
    ...updateData,
    updated_at: new Date().toISOString(),
  };

  // Jika status diubah ke selesai, tambahkan resolved_at
  if (updateData.status && ["Done", "Resolved"].includes(updateData.status)) {
    payload.resolved_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('Unified_Ticket_Tracker')
    .update(payload)
    .eq('ticket_id', ticketId);

  if (error) {
    console.error(`❌ Gagal update ticket ${ticketId}:`, error.message);
    return false;
  }

  console.log(`✅ Ticket ${ticketId} berhasil diupdate`);
  return true;
}

/**
 * Hapus tiket dari database (Soft delete atau hard delete)
 * Default: Hard delete
 */
export async function deleteTicket(ticketId) {
  if (!ticketId) {
    console.warn("⚠️ ticketId kosong");
    return false;
  }

  const { error } = await supabase
    .from('Unified_Ticket_Tracker')
    .delete()
    .eq('ticket_id', ticketId);

  if (error) {
    console.error(`❌ Gagal menghapus ticket ${ticketId}:`, error.message);
    return false;
  }

  console.log(`🗑️ Ticket ${ticketId} berhasil dihapus`);
  return true;
}

// ====================== QUERY FUNCTIONS ======================

export async function getTicketsByStatus(status = null) {
  let query = supabase
    .from('Unified_Ticket_Tracker')
    .select('*')
    .order('processed_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    console.error("❌ Gagal mengambil tiket berdasarkan status:", error.message);
    return [];
  }

  return data || [];
}

export async function getTicketsByDateRange(days = 7) {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);

  const { data, error } = await supabase
    .from('Unified_Ticket_Tracker')
    .select('*')
    .gte('processed_at', fromDate.toISOString())
    .order('processed_at', { ascending: false });

  if (error) {
    console.error(`❌ Gagal mengambil tiket ${days} hari terakhir:`, error.message);
    return [];
  }

  return data || [];
}

export async function searchTickets(keyword) {
  if (!keyword?.trim()) return [];

  const searchTerm = `%${keyword.trim()}%`;

  const { data, error } = await supabase
    .from('Unified_Ticket_Tracker')
    .select('*')
    .or(`subject.ilike.${searchTerm},body.ilike.${searchTerm},summary.ilike.${searchTerm},from.ilike.${searchTerm}`)
    .order('processed_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error("❌ Gagal mencari tiket:", error.message);
    return [];
  }

  return data || [];
}

export async function getDailySummary() {
  const tickets = await getTicketsByDateRange(1);

  return {
    date: new Date().toISOString().split('T')[0],
    total: tickets.length,
    critical: tickets.filter(t => t.priority === "CRITICAL").length,
    high: tickets.filter(t => t.priority === "HIGH").length,
    inProgress: tickets.filter(t => t.status === "In Progress").length,
    done: tickets.filter(t => ["Done", "Resolved"].includes(t.status)).length,
  };
}

// ====================== CONVERSATION THREADING & SESSIONS ======================
/**
 * Mengambil semua tiket aktif (belum selesai) di grup tertentu
 */
export async function findActiveTicketsForGroup(groupId, source) {
  try {
    const { data, error } = await supabase
      .from('Unified_Ticket_Tracker')
      .select('*')
      .eq('source', source)
      .not('status', 'in', '("Done","Resolved","Cancelled","No Action")')
      .like('telegram_chat_id', `%|${groupId}`)
      .order('updated_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error(`❌ Error mencari tiket aktif grup (${groupId}):`, error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("❌ Unexpected error in findActiveTicketsForGroup:", err);
    return [];
  }
}

/**
 * Mencari tiket aktif di grup WhatsApp/Telegram berdasarkan quoted message ID
 * atau berdasarkan status sesi aktif ('OPEN') di tabel 'conversation'
 */
export async function findActiveTicketForThreading(remoteJid, groupSubject, quotedStanzaId = null, source = 'whatsapp') {
  try {
    // 1. Cek berdasarkan quoted message ID jika ada
    if (quotedStanzaId) {
      console.log("Mencari tiket induk dengan email_id = " + quotedStanzaId);
      const { data, error } = await supabase
        .from('Unified_Ticket_Tracker')
        .select('*')
        .eq('email_id', quotedStanzaId)
        .limit(1);

      if (error) {
        console.error("Error mencari parent ticket via quote:", error.message);
      }

      if (data && data.length > 0) {
        const ticket = data[0];
        if (["Done", "Resolved", "Cancelled"].includes(ticket.status)) {
          console.log(`⚠️ Tiket induk ${ticket.ticket_id} ditemukan via quote tetapi statusnya adalah ${ticket.status} (CLOSED). Skip threading.`);
        } else {
          console.log("Ditemukan tiket induk berdasarkan quote: " + ticket.ticket_id);
          return ticket;
        }
      }
    }

    // 2. Cek berdasarkan sesi aktif di tabel 'conversation'
    const conversationKey = `${source}_${remoteJid}`;
    console.log("Mencari sesi aktif di tabel conversation dengan key: " + conversationKey);

    const { data: convData, error: convError } = await supabase
      .from('conversation')
      .select('ticket_id')
      .eq('conversation_key', conversationKey)
      .eq('status', 'OPEN')
      .limit(1);

    if (convError) {
      console.error("Error mencari sesi aktif di tabel conversation:", convError.message);
      return null;
    }

    if (convData && convData.length > 0 && convData[0].ticket_id) {
      const activeTicketId = convData[0].ticket_id;
      console.log("Sesi aktif ditemukan dengan Ticket ID: " + activeTicketId);

      const { data: ticketData, error: ticketError } = await supabase
        .from('Unified_Ticket_Tracker')
        .select('*')
        .eq('ticket_id', activeTicketId)
        .limit(1);

      if (ticketError) {
        console.error("Error mengambil tiket dari database:", ticketError.message);
        return null;
      }

      if (ticketData && ticketData.length > 0) {
        const ticket = ticketData[0];
        if (["Done", "Resolved", "Cancelled"].includes(ticket.status)) {
          console.log(`⚠️ Sesi OPEN tapi tiket ${ticket.ticket_id} sudah ${ticket.status} (CLOSED). Skip threading.`);
        } else {
          return ticket;
        }
      }
    }

    console.log("Tidak ada sesi aktif ditemukan.");
    return null;
  } catch (err) {
    console.error("Unexpected error in findActiveTicketForThreading:", err);
    return null;
  }
}

/**
 * Menambahkan balasan percakapan (follow-up) ke badan (body) tiket yang sudah ada
 */
export async function appendMessageToTicket(ticketId, currentBody, senderName, text) {
  try {
    const timestamp = new Date().toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });

    const formattedAppend = `\n\n💬 [${timestamp} - ${senderName}]: ${text}`;
    const newBody = (currentBody || "") + formattedAppend;

    const { error } = await supabase
      .from('Unified_Ticket_Tracker')
      .update({
        body: newBody,
        updated_at: new Date().toISOString()
      })
      .eq('ticket_id', ticketId);

    if (error) {
      console.error("Gagal menambahkan pesan ke ticket " + ticketId + ":", error.message);
      return false;
    }

    console.log("Berhasil menambahkan balasan ke ticket " + ticketId);
    return true;
  } catch (err) {
    console.error("Unexpected error in appendMessageToTicket:", err);
    return false;
  }
}

/**
 * Membuat atau mengaktifkan sesi percakapan baru berstatus 'OPEN'
 */
export async function createConversationSession(source, groupId, ticketId, lastMessage, summary = null) {
  const conversationKey = `${source}_${groupId}`;
  try {
    const payload = {
      conversation_key: conversationKey,
      ticket_id: ticketId,
      source_channel: source,
      group_id: groupId,
      status: 'OPEN',
      last_message: lastMessage,
      last_message_at: new Date().toISOString(),
      summary: summary
    };

    const { error } = await supabase
      .from('conversation')
      .upsert(payload, { onConflict: 'conversation_key' });

    if (error) {
      console.error("Gagal membuat/mengupdate sesi conversation:", error.message);
      return false;
    }

    console.log("Sesi conversation berhasil dibuat: " + conversationKey);
    return true;
  } catch (err) {
    console.error("Unexpected error in createConversationSession:", err);
    return false;
  }
}

/**
 * Memperbarui data pesan terakhir pada sesi percakapan yang aktif
 */
export async function updateConversationLastMessage(source, groupId, lastMessage) {
  const conversationKey = `${source}_${groupId}`;
  try {
    const { error } = await supabase
      .from('conversation')
      .update({
        last_message: lastMessage,
        last_message_at: new Date().toISOString()
      })
      .eq('conversation_key', conversationKey)
      .eq('status', 'OPEN');

    if (error) {
      console.error("Gagal memperbarui last_message pada sesi:", error.message);
      return false;
    }

    console.log("Sesi " + conversationKey + " diperbarui.");
    return true;
  } catch (err) {
    console.error("Unexpected error in updateConversationLastMessage:", err);
    return false;
  }
}

/**
 * Menutup sesi percakapan (mengubah status menjadi 'CLOSED') berdasarkan ticket_id
 */
export async function closeConversationSessionByTicket(ticketId) {
  try {
    const { error } = await supabase
      .from('conversation')
      .update({ status: 'CLOSED' })
      .eq('ticket_id', ticketId)
      .eq('status', 'OPEN');

    if (error) {
      console.error("Gagal menutup sesi conversation untuk ticket " + ticketId + ":", error.message);
      return false;
    }

    console.log("Sesi conversation untuk ticket " + ticketId + " ditutup (CLOSED).");
    return true;
  } catch (err) {
    console.error("Unexpected error in closeConversationSessionByTicket:", err);
    return false;
  }
}
