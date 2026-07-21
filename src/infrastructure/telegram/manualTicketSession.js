// src/infrastructure/telegram/manualTicketSession.js
//
// State machine in-memory untuk sesi manual input tiket via Telegram.
// Setiap user memiliki sesi tersendiri yang di-track berdasarkan chatId + userId.


// ====================== CONSTANTS ======================

// Session timeout: 10 menit tanpa aktivitas
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// Field yang WAJIB diisi (tidak bisa skip)
export const REQUIRED_FIELDS = ['description', 'category', 'severity'];

// Field yang OPSIONAL (bisa dilewati)
export const OPTIONAL_FIELDS = ['project', 'requester', 'source', 'reported_time', 'issue_type'];

// Semua field yang bisa diedit ulang di sesi baru
export const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// Field yang bisa diedit saat REPAIR tiket dari DB
export const REPAIR_FIELDS = [
  'from', 'subject', 'body', 'summary',
  'category', 'priority', 'source', 'status',
  'description', 'requester', 'project', 'reported_time', 'issue_type'
];

// Label tampilan untuk setiap field
export const FIELD_LABELS = {
  description:   'Deskripsi Masalah',
  category:      'Kategori',
  severity:      'Severity',
  project:       'Project / Sistem',
  requester:     'Nama Pelapor',
  source:        'Sumber Tiket',
  reported_time: 'Waktu Kejadian',
  issue_type:    'Issue Type',
};

// Label untuk field DB (digunakan saat REPAIR)
export const DB_FIELD_LABELS = {
  from:          '👤 Dari (Pengirim)',
  subject:       '📌 Subject / Judul',
  body:          '📝 Isi / Konten Tiket',
  summary:       '🗒 Ringkasan (Summary)',
  category:      '🗂 Kategori',
  priority:      '🚦 Priority',
  source:        '📞 Sumber Tiket',
  status:        '🔄 Status',
  description:   '📝 Deskripsi Masalah',
  requester:     '👤 Nama Pelapor',
  project:       '🖥 Project / Sistem',
  reported_time: '⏰ Waktu Kejadian',
  issue_type:    '📌 Issue Type',
};

// Pertanyaan follow-up untuk setiap field
export const FIELD_QUESTIONS = {
  description: '📝 Tolong ceritakan lebih detail masalahnya. Apa yang terjadi?',
  category:    '🗂 Apa kategori tiket ini?',
  severity:    '🚦 Berapa tingkat severity masalah ini?',
  project:     '🖥 Project atau sistem apa yang terdampak?',
  requester:   '👤 Siapa nama dan posisi orang yang melaporkan?',
  source:      '📞 Dari mana tiket ini masuk?',
  reported_time: '⏰ Kapan masalah ini terjadi atau dilaporkan? (contoh: 14:30 WIB, tadi pagi)',
  issue_type:  '📌 Pilih tipe issue ini:',
  // DB fields
  from:        '👤 Siapa pengirim / pelapor tiket ini?',
  subject:     '📌 Apa subject atau judul tiket ini?',
  body:        '📝 Tulis ulang isi / konten lengkap tiket:',
  summary:     '🗒 Buat ringkasan singkat tiket ini:',
  priority:    '🚦 Pilih priority tiket:',
  status:      '🔄 Pilih status tiket:',
};

// Pilihan jawaban cepat (inline keyboard) untuk field tertentu
export const FIELD_OPTIONS = {
  category: [
    [{ text: '🔴 Incident Management', callback_data: 'fq_category_Incident Management' }],
    [{ text: '📋 Service Request', callback_data: 'fq_category_Service Request Management' }],
    [{ text: '🔄 Change Management', callback_data: 'fq_category_Change Management' }],
    [{ text: '🔍 Problem Management', callback_data: 'fq_category_Problem Management' }],
  ],
  severity: [
    [
      { text: '🔴 Emergency', callback_data: 'fq_severity_emergency' },
      { text: '🟠 High',      callback_data: 'fq_severity_high' },
    ],
    [
      { text: '🟡 Medium',   callback_data: 'fq_severity_medium' },
      { text: '🟢 Low',      callback_data: 'fq_severity_low' },
    ],
    [
      { text: '⚪ Others',   callback_data: 'fq_severity_others' },
    ],
  ],
  priority: [
    [
      { text: '🔴 CRITICAL', callback_data: 'rq_priority_CRITICAL' },
      { text: '🟠 HIGH',     callback_data: 'rq_priority_HIGH' },
    ],
    [
      { text: '🟡 MEDIUM',   callback_data: 'rq_priority_MEDIUM' },
      { text: '🟢 LOW',      callback_data: 'rq_priority_LOW' },
    ],
  ],
  status: [
    [{ text: '🔄 In Progress',         callback_data: 'rq_status_In Progress' }],
    [{ text: '✅ Done',                callback_data: 'rq_status_Done' }],
    [{ text: '🔼 Escalated',           callback_data: 'rq_status_Escalated' }],
    [{ text: '❌ Cancelled',           callback_data: 'rq_status_Cancelled' }],
    [{ text: '➖ No Action',           callback_data: 'rq_status_NoAction' }],
  ],
  project: [
    [
      { text: '🔷 Single Mediation',         callback_data: 'fq_project_Single Mediation' },
      { text: '🔷 Message Broker',            callback_data: 'fq_project_Message Broker' }
    ],
    [
      { text: '🔷 APH Mediation',             callback_data: 'fq_project_APH Mediation' },
      { text: '🔷 Unified Network Mediation', callback_data: 'fq_project_Unified Network Mediation' }
    ],
    [
      { text: '🔷 Umbrella SIEM',             callback_data: 'fq_project_Umbrella SIEM' },
      { text: '🔷 Enterprise Catalog',        callback_data: 'fq_project_Enterprise Product Catalog' }
    ],
    [
      { text: '🔷 B2B Surveillance',          callback_data: 'fq_project_B2B Service Surveillance' },
      { text: '🔷 Device Management',         callback_data: 'fq_project_Device Management' }
    ],
    [
      { text: '🔷 CDR & LUADR',               callback_data: 'fq_project_CDR & LUADR' },
      { text: '⚪ Others',                    callback_data: 'fq_project_Others' }
    ]
  ],
  source: [
    [
      { text: '📧 Email',   callback_data: 'fq_source_email' },
      { text: '📞 Telepon', callback_data: 'fq_source_telepon' },
    ],
    [
      { text: '💬 WhatsApp', callback_data: 'fq_source_whatsapp' },
      { text: '🚶 Walk-in',  callback_data: 'fq_source_walk-in' },
    ],
    [
      { text: '✈️ Telegram', callback_data: 'fq_source_telegram' },
      { text: '❓ Lainnya',  callback_data: 'fq_source_lainnya' },
    ],
  ],
  issue_type: [
    [{ text: '🔄 Change Management',      callback_data: 'fq_issue_type_Change Management' }],
    [{ text: '🚨 Incident Management',    callback_data: 'fq_issue_type_Incident Management' }],
    [{ text: '📚 Knowledge Management',   callback_data: 'fq_issue_type_Knowledge Management' }],
    [{ text: '🔍 Problem Management',     callback_data: 'fq_issue_type_Problem Management' }],
    [{ text: '🤝 Relationship Management',callback_data: 'fq_issue_type_Relationship Management' }],
    [{ text: '📋 Service Request Management', callback_data: 'fq_issue_type_Service Request Management' }],
  ],
};

// ====================== SESSION STORE ======================
/** @type {Map<string, Object>} */
const sessions = new Map();

/**
 * Buat session key dari chatId dan userId.
 */
function makeKey(chatId, userId) {
  return `${chatId}_${userId}`;
}

// ====================== SESSION LIFECYCLE ======================
/**
 * Buat sesi baru untuk user yang memulai /tiket baru.
 */
export function createSession(chatId, userId, senderName = 'Unknown') {
  const key = makeKey(chatId, userId);

  const session = {
    key,
    chatId: chatId.toString(),
    userId: userId.toString(),
    senderName,
    step: 'AWAITING_TEXT',    // AWAITING_TEXT | FOLLOWUP | CONFIRM | EDITING | DRAFT_REVIEW | REPAIR_EDITING
    mode: 'NEW',              // 'NEW' | 'REPAIR'
    data: {
      description:   null,
      category:      null,
      severity:      null,
      project:       null,
      requester:     null,
      source:        null,
      reported_time: null,
      issue_type:    null,
    },
    // Untuk mode REPAIR — menyimpan data tiket DB asli
    repairTicket:   null,     // object tiket dari DB
    repairData:     {},       // field yang sudah diedit user
    pendingFields:  [],
    currentField:   null,
    editingField:   null,   // field yang sedang diedit saat state EDITING
    rawText:        null,
    timestamp:      Date.now(),
  };

  sessions.set(key, session);
  scheduleSessionCleanup(key);
  return session;
}

/**
 * Buat sesi REPAIR dari tiket yang sudah ada di DB.
 * Mode ini memungkinkan user mengedit semua field tiket existing.
 * PENTING: processed_at dan ticket_id TIDAK boleh diubah.
 */
export function createRepairSession(chatId, userId, ticket, senderName = 'Unknown') {
  const key = makeKey(chatId, userId);

  const session = {
    key,
    chatId: chatId.toString(),
    userId: userId.toString(),
    senderName,
    step: 'REPAIR_EDITING',
    mode: 'REPAIR',
    data: {},     // tidak dipakai di mode repair
    repairTicket: { ...ticket },   // snapshot tiket asli dari DB (immutable reference)
    repairData: {
      // Salin semua field yang boleh diedit dari tiket DB
      from:          ticket.from          || null,
      subject:       ticket.subject       || null,
      body:          ticket.body          || null,
      summary:       ticket.summary       || null,
      category:      ticket.category      || null,
      priority:      ticket.priority      || null,
      source:        ticket.source        || null,
      status:        ticket.status        || null,
    },
    pendingFields:  [],
    currentField:   null,
    editingField:   null,
    rawText:        null,
    timestamp:      Date.now(),
  };

  sessions.set(key, session);
  scheduleSessionCleanup(key);
  return session;
}

/**
 * Ambil sesi aktif berdasarkan chatId + userId.
 */
export function getSession(chatId, userId) {
  const key = makeKey(chatId, userId);
  const session = sessions.get(key);
  if (!session) return null;

  if (Date.now() - session.timestamp > SESSION_TIMEOUT_MS) {
    sessions.delete(key);
    return null;
  }

  session.timestamp = Date.now();
  return session;
}

/**
 * Hapus sesi (setelah tiket disimpan atau user cancel)
 */
export function destroySession(chatId, userId) {
  const key = makeKey(chatId, userId);
  sessions.delete(key);
}

/**
 * Update data dalam sesi.
 */
export function updateSession(chatId, userId, updates) {
  const session = getSession(chatId, userId);
  if (!session) return null;
  Object.assign(session, updates);
  session.timestamp = Date.now();
  return session;
}

// ====================== FIELD LOGIC ======================

/**
 * Setelah AI extraction, merge hasil ke session.data dan tentukan field yang perlu follow-up.
 */
export function computePendingFields(extractedData, session) {
  const pending = [];

  // Merge hasil extraction ke session.data
  for (const field of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const val = extractedData[field];
    if (val !== null && val !== undefined && val !== '') {
      session.data[field] = val;
    }
  }

  // Required fields yang masih kosong → wajib ditanyakan
  for (const field of REQUIRED_FIELDS) {
    if (!session.data[field]) pending.push(field);
  }
  // Optional fields yang kosong → opsional
  for (const field of OPTIONAL_FIELDS) {
    if (!session.data[field]) pending.push(field);
  }

  return pending;
}

// ====================== FIELD VALIDATION ======================

/**
 * Validasi nilai field sebelum disimpan ke session.
 * @returns {{ valid: boolean, message?: string }}
 */
export function validateField(field, value) {
  if (value === null || value === undefined) {
    return REQUIRED_FIELDS.includes(field)
      ? { valid: false, message: `Field ${FIELD_LABELS[field] || field} wajib diisi.` }
      : { valid: true };
  }

  const v = String(value).trim();

  switch (field) {
    case 'description':
    case 'body':
      if (v.length < 5) return { valid: false, message: '❌ Teks terlalu singkat (minimal 5 karakter).' };
      return { valid: true };

    case 'category': {
      const validCategories = ['Incident Management', 'Service Request Management', 'Change Management', 'Problem Management'];
      const match = validCategories.find(c => c.toLowerCase() === v.toLowerCase());
      if (!match) return { valid: false, message: `❌ Kategori tidak valid. Pilih salah satu: ${validCategories.join(', ')}` };
      return { valid: true, normalized: match };
    }

    case 'severity': {
      const validSeverities = ['emergency', 'high', 'medium', 'low', 'others'];
      if (!validSeverities.includes(v.toLowerCase())) {
        return { valid: false, message: `❌ Severity tidak valid. Pilih: ${validSeverities.join(', ')}` };
      }
      return { valid: true, normalized: v.toLowerCase() };
    }

    case 'priority': {
      const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      const match = validPriorities.find(p => p.toLowerCase() === v.toLowerCase());
      if (!match) return { valid: false, message: `❌ Priority tidak valid. Pilih: ${validPriorities.join(', ')}` };
      return { valid: true, normalized: match };
    }

    case 'status': {
      const validStatuses = ['In Progress', 'Done', 'Escalated', 'Cancelled', 'NoAction', 'Draft', 'Pending Confirmation'];
      const match = validStatuses.find(s => s.toLowerCase() === v.toLowerCase());
      if (!match) return { valid: false, message: `❌ Status tidak valid.` };
      return { valid: true, normalized: match };
    }

    case 'requester':
    case 'from':
      if (v.length < 2) return { valid: false, message: '❌ Nama minimal 2 karakter.' };
      return { valid: true };

    case 'reported_time':
      if (!/\d/.test(v) && !/pagi|siang|sore|malam|tadi|kemarin|hari ini|jam/i.test(v)) {
        return { valid: false, message: '❌ Format waktu tidak valid. Contoh: "14:30 WIB", "tadi pagi", "kemarin jam 09.00".' };
      }
      return { valid: true };

    default:
      return { valid: true };
  }
}

/**
 * Apakah field ini wajib?
 */
export function isRequiredField(field) {
  return REQUIRED_FIELDS.includes(field);
}

/**
 * Dapatkan follow-up question + keyboard untuk field tertentu.
 */
export function getFieldPrompt(field, canSkip = false, prefix = 'fq') {
  const question = FIELD_QUESTIONS[field] || `Isi nilai untuk ${DB_FIELD_LABELS[field] || FIELD_LABELS[field] || field}:`;

  // Gunakan options repair (rq_) jika field DB seperti priority/status
  let options = null;
  if (prefix === 'rq') {
    options = FIELD_OPTIONS[field] || null;
  } else {
    options = FIELD_OPTIONS[field] || null;
  }

  let inlineKeyboard = [];
  if (options) {
    inlineKeyboard = [...options];
  }

  if (canSkip) {
    inlineKeyboard.push([{ text: '⏭ Lewati (kosongkan)', callback_data: `${prefix}_skip_${field}` }]);
  }

  inlineKeyboard.push([{ text: '❌ Batalkan', callback_data: 'manual_cancel' }]);

  const keyboard = {
    reply_markup: {
      inline_keyboard: inlineKeyboard
    }
  };

  return { question, keyboard };
}

// ====================== SUMMARY FORMATTER ======================

/**
 * Format ringkasan tiket dari session.data untuk konfirmasi akhir.
 * Mengembalikan { text, keyboard } — keyboard berisi tombol edit per field + simpan/batal.
 */
export function formatSessionSummary(session) {
  const d = session.data;

  const severityEmoji = {
    emergency: '🔴', high: '🟠', medium: '🟡', low: '🟢', others: '⚪'
  }[(d.severity || '').toLowerCase()] || '⚪';

  const categoryShort = {
    'Incident Management':         '🚨 Incident Management',
    'Service Request Management':  '📋 Service Request Management',
    'Change Management':           '🔄 Change Management',
    'Problem Management':          '🔍 Problem Management',
  }[d.category] || d.category || '-';

  const sourceMap = {
    email: '📧 Email', telepon: '📞 Telepon', whatsapp: '💬 WhatsApp',
    'walk-in': '🚶 Walk-in', telegram: '✈️ Telegram', lainnya: '❓ Lainnya'
  };

  const text = `📋 <b>Ringkasan Tiket — Mohon periksa kembali</b>

📌 Kategori    : ${categoryShort}
${severityEmoji} Severity     : ${d.severity || '-'}
🖥 Project     : ${d.project || '<i>tidak disebutkan</i>'}
👤 Pelapor     : ${d.requester || '<i>tidak disebutkan</i>'}
📞 Sumber      : ${sourceMap[d.source] || d.source || '<i>tidak disebutkan</i>'}
⏰ Waktu       : ${d.reported_time || '<i>tidak disebutkan</i>'}
📌 Issue Type  : ${d.issue_type || '-'}

📝 <b>Deskripsi:</b>
${d.description || '-'}

━━━━━━━━━━━━━━━━━━━━━
✏️ Tekan tombol field di bawah untuk mengedit, atau simpan jika sudah benar.`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✏️ Deskripsi', callback_data: 'edit_field_description' },
          { text: '✏️ Kategori',  callback_data: 'edit_field_category' },
          { text: '✏️ Severity',  callback_data: 'edit_field_severity' },
        ],
        [
          { text: '✏️ Project',   callback_data: 'edit_field_project' },
          { text: '✏️ Pelapor',   callback_data: 'edit_field_requester' },
        ],
        [
          { text: '✏️ Sumber',    callback_data: 'edit_field_source' },
          { text: '✏️ Waktu',     callback_data: 'edit_field_reported_time' },
          { text: '✏️ Issue Type',callback_data: 'edit_field_issue_type' },
        ],
        [
          { text: '✅ Simpan Tiket', callback_data: 'manual_confirm' },
          { text: '❌ Batalkan',     callback_data: 'manual_cancel' },
        ],
      ]
    }
  };

  return { text, keyboard };
}

/**
 * Format ringkasan REPAIR tiket dari DB untuk ditampilkan di grup UTT.
 * Mengembalikan { text, keyboard } — keyboard berisi tombol edit per field + re-publish/batal.
 */
export function formatRepairSummary(session) {
  const t = session.repairTicket;  // data original dari DB
  const d = session.repairData;    // data yang sudah diedit (override)

  // Gabungkan: gunakan repairData jika ada, fallback ke repairTicket
  const from          = d.from     !== undefined ? d.from     : t.from;
  const subject       = d.subject  !== undefined ? d.subject  : t.subject;
  const body          = d.body     !== undefined ? d.body     : t.body;
  const summary       = d.summary  !== undefined ? d.summary  : t.summary;
  const category      = d.category !== undefined ? d.category : t.category;
  const priority      = d.priority !== undefined ? d.priority : t.priority;
  const source        = d.source   !== undefined ? d.source   : t.source;
  const status        = d.status   !== undefined ? d.status   : t.status;

  const priorityEmoji = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢' }[priority?.toUpperCase()] || '⚪';
  const sourceMap = {
    email: '📧 Email', telepon: '📞 Telepon', whatsapp: '💬 WhatsApp',
    'walk-in': '🚶 Walk-in', telegram: '✈️ Telegram',
    telegram_manual: '✈️ Telegram (Manual)', lainnya: '❓ Lainnya'
  };

  // Format tanggal created_at (tidak berubah!)
  const createdAt = t.processed_at
    ? new Date(t.processed_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })
    : '-';

  const text = `🔧 <b>Repair Tiket — Periksa & Edit Sebelum Re-Publish</b>

🎫 <b>Ticket ID</b>  : <code>${t.ticket_id}</code>
📅 <b>Dibuat</b>     : ${createdAt} <i>(tidak berubah)</i>

━━━━━━━━━━━━━━━━━━━━━
👤 <b>Dari</b>       : ${from || '-'}
📌 <b>Subject</b>    : ${subject || '-'}
🗂 <b>Kategori</b>   : ${category || '-'}
${priorityEmoji} <b>Priority</b>   : ${priority || '-'}
📞 <b>Sumber</b>     : ${sourceMap[source] || source || '-'}
🔄 <b>Status</b>     : ${status || '-'}

🗒 <b>Summary:</b>
${summary || '<i>-</i>'}

📝 <b>Body / Isi Tiket:</b>
${body ? body.substring(0, 300) + (body.length > 300 ? '...' : '') : '<i>-</i>'}

━━━━━━━━━━━━━━━━━━━━━
✏️ Edit field yang perlu diubah, lalu tekan <b>Re-Publish Update</b>.`;

  const ticketId = t.ticket_id;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✏️ Dari',     callback_data: `repair_edit_from_${ticketId}` },
          { text: '✏️ Subject',  callback_data: `repair_edit_subject_${ticketId}` },
        ],
        [
          { text: '✏️ Kategori', callback_data: `repair_edit_category_${ticketId}` },
          { text: '✏️ Priority', callback_data: `repair_edit_priority_${ticketId}` },
        ],
        [
          { text: '✏️ Sumber',   callback_data: `repair_edit_source_${ticketId}` },
          { text: '✏️ Status',   callback_data: `repair_edit_status_${ticketId}` },
        ],
        [
          { text: '✏️ Summary',  callback_data: `repair_edit_summary_${ticketId}` },
        ],
        [
          { text: '✏️ Body/Isi', callback_data: `repair_edit_body_${ticketId}` },
        ],
        [
          { text: '🚀 Re-Publish Update ke Beacon', callback_data: `repair_publish_${ticketId}` },
        ],
        [
          { text: '❌ Batalkan Repair', callback_data: 'manual_cancel' },
        ],
      ]
    }
  };

  return { text, keyboard };
}

/**
 * Format pesan DRAFT tiket yang dikirim ke grup UTT untuk pre-confirmation.
 * Mengembalikan { text, keyboard }
 */
export function formatDraftForUTT(session, ticketId) {
  const d = session.data;

  const severityEmoji = {
    emergency: '🔴', high: '🟠', medium: '🟡', low: '🟢', others: '⚪'
  }[(d.severity || '').toLowerCase()] || '⚪';

  const sourceMap = {
    email: '📧 Email', telepon: '📞 Telepon', whatsapp: '💬 WhatsApp',
    'walk-in': '🚶 Walk-in', telegram: '✈️ Telegram', lainnya: '❓ Lainnya',
    telegram_manual: '✈️ Telegram (Manual)'
  };

  const now = new Date();
  const waktu = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  const tanggal = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

  const text = `📝 <b>TIKET DRAFT — Menunggu Konfirmasi</b>

🎫 <b>Ticket ID</b>  : <code>${ticketId}</code>
📅 <b>Waktu Input</b>: ${tanggal}, ${waktu} WIB
👤 <b>Diinput oleh</b>: ${session.senderName}

━━━━━━━━━━━━━━━━━━━━━
${severityEmoji} <b>Severity</b>   : ${d.severity || '-'}
🗂 <b>Kategori</b>   : ${d.category || '-'}
🖥 <b>Project</b>    : ${d.project || '-'}
👤 <b>Pelapor</b>    : ${d.requester || '-'}
📞 <b>Sumber</b>     : ${sourceMap[d.source] || d.source || '-'}
⏰ <b>Waktu Kejadian</b>: ${d.reported_time || '-'}
📌 <b>Issue Type</b> : ${d.issue_type || '-'}

📝 <b>Deskripsi:</b>
${d.description || '-'}

━━━━━━━━━━━━━━━━━━━━━
⚠️ <i>Apakah tiket ini sudah benar? Konfirmasi sebelum dipublish ke Beacon.</i>`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Fix & Publish ke Beacon', callback_data: `draft_publish_${ticketId}` },
        ],
        [
          { text: '✏️ Masih ada perubahan', callback_data: `draft_edit_${ticketId}` },
        ],
        [
          { text: '❌ Batalkan (Hapus Draft)', callback_data: `draft_cancel_${ticketId}` },
        ],
      ]
    }
  };

  return { text, keyboard };
}

// ====================== CLEANUP ======================

function scheduleSessionCleanup(key) {
  setTimeout(() => {
    const session = sessions.get(key);
    if (session && Date.now() - session.timestamp >= SESSION_TIMEOUT_MS) {
      sessions.delete(key);
      console.log(`🧹 Session expired dan dihapus: ${key}`);
    }
  }, SESSION_TIMEOUT_MS + 1000);
}
