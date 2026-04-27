// src/database/supabase.js

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Gunakan service_role key untuk backend (sangat direkomendasikan)
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// ====================== GENERATE TICKET ID ======================
export async function generateTicketId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  console.log(`🔍 Generating ticket ID for date: ${dateStr}`);

  const { data, error } = await supabase
    .from('Unified_Ticket_Tracker')           // ← Nama tabel BENAR, tanpa spasi
    .select('ticket_id')
    .like('ticket_id', `INC-${dateStr}-%`)
    .order('ticket_id', { ascending: false })
    .limit(1);

  if (error) {
    console.error("❌ Error generate ticket_id:", error);
    // Fallback
    const fallbackId = `INC-${dateStr}-0001`;
    console.log(`⚠️ Using fallback ticket ID: ${fallbackId}`);
    return fallbackId;
  }

  let sequence = 1;

  if (data && data.length > 0 && data[0].ticket_id) {
    const lastTicketId = data[0].ticket_id;
    const lastSequence = parseInt(lastTicketId.split('-').pop(), 10);
    if (!isNaN(lastSequence)) {
      sequence = lastSequence + 1;
    }
  }

  const newTicketId = `INC-${dateStr}-${String(sequence).padStart(4, '0')}`;
  console.log(`✅ Generated ticket ID: ${newTicketId}`);
  return newTicketId;
}

// ====================== SAVE TICKET ======================
export async function saveEmailLog(email, analysis, telegramSent, telegramMessageId = null, telegramChatId = null) {
  try {
    const ticketId = await generateTicketId();

    const payload = {
      ticket_id: ticketId,
      email_id: email.id || email.messageId || Date.now().toString(),
      from: email.from || null,
      subject: email.subject || null,
      body: email.body || null,
      summary: analysis?.summary || null,
      category: analysis?.category || null,
      priority: analysis?.priority || 'MEDIUM',
      source: email.source || "whatsapp",
      telegram_sent: telegramSent,
      telegram_message_id: telegramMessageId,
      telegram_chat_id: telegramChatId,
      status: telegramSent ? "In Progress" : "Logged (No Action)",
      processed_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('Unified_Ticket_Tracker')        // ← Nama tabel BENAR
      .insert([payload]);

    if (error) {
      console.error("❌ Gagal simpan log email:", error);
      console.error("Payload yang dikirim:", payload);
      return null;
    }

    console.log(`✅ Ticket berhasil dibuat: ${ticketId}`);
    return ticketId;

  } catch (err) {
    console.error("❌ Unexpected error in saveEmailLog:", err);
    return null;
  }
}

// ====================== UPDATE STATUS ======================
export async function updateIncidentStatus(telegramMessageId, status) {
  const { error } = await supabase
    .from('Unified_Ticket_Tracker')
    .update({ 
      status,
      resolved_at: status === "Done" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    })
    .eq('telegram_message_id', telegramMessageId);

  if (error) {
    console.error("❌ Gagal update status:", error);
  } else {
    console.log(`✅ Status updated to "${status}" for telegram_message_id: ${telegramMessageId}`);
  }
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
    console.error("❌ Gagal ambil tiket:", error);
    return [];
  }
  return data || [];
}

export async function getTicketsByDateRange(days = 7) {
  const date = new Date();
  date.setDate(date.getDate() - days);

  const { data, error } = await supabase
    .from('Unified_Ticket_Tracker')
    .select('*')
    .gte('processed_at', date.toISOString())
    .order('processed_at', { ascending: false });

  if (error) {
    console.error("❌ Gagal ambil tiket berdasarkan tanggal:", error);
    return [];
  }
  return data || [];
}

export async function searchTickets(keyword) {
  const searchTerm = `%${keyword.toLowerCase()}%`;

  const { data, error } = await supabase
    .from('Unified_Ticket_Tracker')
    .select('*')
    .or(`subject.ilike.${searchTerm},body.ilike.${searchTerm},summary.ilike.${searchTerm},from.ilike.${searchTerm}`)
    .order('processed_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error("❌ Gagal search tiket:", error);
    return [];
  }
  return data || [];
}

export async function getDailySummary() {
  const tickets = await getTicketsByDateRange(1);

  const summary = {
    total: tickets.length,
    critical: tickets.filter(t => t.priority === "CRITICAL").length,
    high: tickets.filter(t => t.priority === "HIGH").length,
    inProgress: tickets.filter(t => t.status === "In Progress").length,
    done: tickets.filter(t => t.status === "Done").length,
    date: new Date().toISOString().split('T')[0]
  };

  return summary;
}