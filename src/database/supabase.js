// src/database/supabase.js

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

// ====================== GENERATE TICKET ID ======================
export async function generateTicketId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  // Ambil ticket_id tertinggi hari ini
  const { data, error } = await supabase
    .from('Unified_Incident_Intake')
    .select('ticket_id')
    .like('ticket_id', `INC-${dateStr}-%`)
    .order('ticket_id', { ascending: false })
    .limit(1);

  if (error) {
    console.error("❌ Error generate ticket_id:", error);
    // Fallback jika error
    return `INC-${dateStr}-0001`;
  }

  let sequence = 1;

  if (data && data.length > 0 && data[0].ticket_id) {
    const lastTicketId = data[0].ticket_id;
    const lastSequence = parseInt(lastTicketId.split('-').pop(), 10);
    if (!isNaN(lastSequence)) {
      sequence = lastSequence + 1;
    }
  }

  return `INC-${dateStr}-${String(sequence).padStart(4, '0')}`;
}

export async function saveEmailLog(email, analysis, telegramSent, telegramMessageId = null, telegramChatId = null) {
  const ticketId = await generateTicketId();

  const { error } = await supabase.from('Unified_Incident_Intake').insert([{
    ticket_id: ticketId,
    email_id: email.id || email.messageId || Date.now().toString(),
    from: email.from,
    subject: email.subject,
    body: email.body,
    summary: analysis.summary,
    category: analysis.category,
    priority: analysis.priority,
    source: email.source || "whatsapp",
    telegram_sent: telegramSent,
    telegram_message_id: telegramMessageId,
    telegram_chat_id: telegramChatId,
    status: telegramSent ? "In Progress" : "Logged (No Action)",
    processed_at: new Date().toISOString()
  }]);

  if (error) {
    console.error("❌ Gagal simpan log email:", error);
    return null;
  } 

  console.log(`✅ Ticket dibuat: ${ticketId}`);
  return ticketId;        // ← Penting: return ticketId
}

// ====================== FUNGSI LAIN (Update Status, Get Tickets, dll) ======================
export async function updateIncidentStatus(telegramMessageId, status) {
  const { error } = await supabase
    .from('Unified_Incident_Intake')
    .update({ 
      status,
      resolved_at: status === "Done" ? new Date().toISOString() : null 
    })
    .eq('telegram_message_id', telegramMessageId);

  if (error) console.error("❌ Gagal update status:", error);
}

// Fungsi get tiket (sudah ada sebelumnya, tetap dipertahankan)
export async function getTicketsByStatus(status = null) {
  let query = supabase
    .from('Unified_Incident_Intake')
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
    .from('Unified_Incident_Intake')
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
    .from('Unified_Incident_Intake')
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