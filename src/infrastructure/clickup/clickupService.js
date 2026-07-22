// src/infrastructure/clickup/clickupService.js
// Stub ClickUp service — belum diimplementasikan
// Kosongkan / non-aktifkan integrasi ClickUp sampai konfigurasi tersedia

import { env } from '../../config/env.js';

/**
 * Push tiket ke ClickUp (belum aktif — perlu CLICKUP_API_KEY dan CLICKUP_LIST_ID)
 * @param {Object} ticket - Data tiket dari Unified_Ticket_Tracker
 * @returns {Promise<string|null>} ClickUp task URL atau null jika gagal/tidak dikonfigurasi
 */
export async function pushTicketToClickUp(ticket) {
  if (!env.CLICKUP_API_KEY || !env.CLICKUP_LIST_ID) {
    console.warn('⚠️ ClickUp integration dinonaktifkan: CLICKUP_API_KEY / CLICKUP_LIST_ID belum diisi di .env');
    return null;
  }

  try {
    const { default: fetch } = await import('node-fetch');

    const priorityMap = { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 };
    const priority = priorityMap[(ticket.priority || 'MEDIUM').toUpperCase()] || 3;

    const payload = {
      name: ticket.subject || `[${ticket.ticket_id}] ${(ticket.body || '').substring(0, 100)}`,
      description: `**Ticket ID:** ${ticket.ticket_id}\n\n**From:** ${ticket.from || '-'}\n\n**Category:** ${ticket.category || '-'}\n\n**Source:** ${ticket.source || '-'}\n\n**Body:**\n${ticket.body || '-'}`,
      priority,
      status: 'Open',
      custom_fields: [],
    };

    const response = await fetch(`https://api.clickup.com/api/v2/list/${env.CLICKUP_LIST_ID}/task`, {
      method: 'POST',
      headers: {
        'Authorization': env.CLICKUP_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ ClickUp API error (${response.status}):`, errText);
      return null;
    }

    const data = await response.json();
    const taskUrl = data.url || `https://app.clickup.com/t/${data.id}`;
    console.log(`✅ Tiket ${ticket.ticket_id} berhasil dipush ke ClickUp: ${taskUrl}`);
    return taskUrl;

  } catch (err) {
    console.error('❌ Gagal push ke ClickUp:', err.message);
    return null;
  }
}
