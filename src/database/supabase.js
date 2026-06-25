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
      .like('ticket_id', `INC-${dateStr}-%`)
      .order('ticket_id', { ascending: false })
      .limit(1);

    if (error) {
      console.error("❌ Error generate ticket_id:", error.message);
      return `INC-${dateStr}-0001`; // Fallback
    }

    let sequence = 1;

    if (data && data.length > 0 && data[0].ticket_id) {
      const lastSequence = parseInt(data[0].ticket_id.split('-').pop(), 10);
      if (!isNaN(lastSequence)) {
        sequence = lastSequence + 1;
      }
    }

    const newTicketId = `INC-${dateStr}-${String(sequence).padStart(4, '0')}`;
    console.log(`✅ Generated Ticket ID: ${newTicketId}`);
    return newTicketId;

  } catch (err) {
    console.error("❌ Unexpected error in generateTicketId:", err);
    return `INC-${dateStr}-0001`;
  }
}

// ====================== SAVE TICKET ======================
/**
 * Menyimpan laporan incident baru ke database
 */
export async function saveEmailLog(email, analysis = {}, telegramSent = false, telegramMessageId = null, telegramChatId = null) {
  try {
    // Gunakan ticket_id yang sudah digenerate (jika ada)
    const ticketId = email.id || await generateTicketId();

    const payload = {
      ticket_id: ticketId,
      email_id: email.id || email.messageId || Date.now().toString(),
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
      status: telegramSent ? "In Progress" : "Logged (No Action)",
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

  if (["Done", "Resolved"].includes(newStatus)) {
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
  return true;
}

/**
 * Ambil detail satu tiket berdasarkan ticket_id
 */
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