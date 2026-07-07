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
    step: 'AWAITING_TEXT',
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
    pendingFields: [],
    currentField:  null,
    rawText:       null,
    timestamp:     Date.now(),
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
 * Hapus sesi (setelah tiket disimpan atau user cancel).
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

/**
 * Apakah field ini wajib?
 */
export function isRequiredField(field) {
  return REQUIRED_FIELDS.includes(field);
}

/**
 * Dapatkan follow-up question + keyboard untuk field tertentu.
 */
export function getFieldPrompt(field, canSkip = false) {
  const question = FIELD_QUESTIONS[field] || `Isi nilai untuk ${FIELD_LABELS[field] || field}:`;
  const options = FIELD_OPTIONS[field] || null;

  let inlineKeyboard = [];
  if (options) {
    inlineKeyboard = [...options];
  }

  if (canSkip) {
    inlineKeyboard.push([{ text: '⏭ Lewati (kosongkan)', callback_data: `fq_skip_${field}` }]);
  }

  inlineKeyboard.push([{ text: '❌ Batalkan Input Tiket', callback_data: 'manual_cancel' }]);

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

  return `📋 <b>Ringkasan Tiket</b>

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
Apakah data di atas sudah benar?`;
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
