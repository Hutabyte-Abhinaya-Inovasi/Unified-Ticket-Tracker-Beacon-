// src/infrastructure/telegram/manualTicketSession.js
//
// State machine in-memory untuk sesi manual input tiket via Telegram.
// Setiap user memiliki sesi tersendiri yang di-track berdasarkan chatId + userId.

// ====================== CONSTANTS ======================

// Session timeout: 10 menit tanpa aktivitas
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// Field yang WAJIB diisi (tidak bisa skip)
export const REQUIRED_FIELDS = ['description', 'category', 'priority'];

// Field yang OPSIONAL (bisa dilewati)
export const OPTIONAL_FIELDS = ['project', 'requester', 'source', 'reported_time', 'issue_type'];

// Label tampilan untuk setiap field
export const FIELD_LABELS = {
  description:   'Deskripsi Masalah',
  category:      'Kategori',
  priority:      'Prioritas',
  project:       'Project / Sistem',
  requester:     'Nama Pelapor',
  source:        'Sumber Tiket',
  reported_time: 'Waktu Kejadian',
  issue_type:    'Tipe (Incident/Request)',
};

// Pertanyaan follow-up untuk setiap field
export const FIELD_QUESTIONS = {
  description: '📝 Tolong ceritakan lebih detail masalahnya. Apa yang terjadi?',
  category:    '🗂 Apa kategori tiket ini?',
  priority:    '🚦 Berapa tingkat urgensi masalah ini?',
  project:     '🖥 Sistem atau project apa yang terdampak? (contoh: SIMRS, ERP, Website)',
  requester:   '👤 Siapa nama dan posisi orang yang melaporkan?',
  source:      '📞 Dari mana tiket ini masuk?',
  reported_time: '⏰ Kapan masalah ini terjadi atau dilaporkan? (contoh: 14:30 WIB, tadi pagi)',
  issue_type:  '📌 Ini termasuk tipe apa?',
};

// Pilihan jawaban cepat (inline keyboard) untuk field tertentu
export const FIELD_OPTIONS = {
  category: [
    [{ text: '🔴 Incident Management', callback_data: 'fq_category_Incident Management' }],
    [{ text: '📋 Service Request', callback_data: 'fq_category_Service Request Management' }],
    [{ text: '🔄 Change Management', callback_data: 'fq_category_Change Management' }],
    [{ text: '🔍 Problem Management', callback_data: 'fq_category_Problem Management' }],
  ],
  priority: [
    [
      { text: '🟢 LOW',    callback_data: 'fq_priority_LOW' },
      { text: '🟡 MEDIUM', callback_data: 'fq_priority_MEDIUM' },
    ],
    [
      { text: '🟠 HIGH',     callback_data: 'fq_priority_HIGH' },
      { text: '🔴 CRITICAL', callback_data: 'fq_priority_CRITICAL' },
    ],
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
    [
      { text: '🚨 Incident',  callback_data: 'fq_issue_type_incident' },
      { text: '📋 Request',   callback_data: 'fq_issue_type_request' },
    ],
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
      priority:      null,
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

  const priorityEmoji = {
    CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🟢'
  }[d.priority] || '⚪';

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
${priorityEmoji} Prioritas    : ${d.priority || '-'}
🖥 Project     : ${d.project || '<i>tidak disebutkan</i>'}
👤 Pelapor     : ${d.requester || '<i>tidak disebutkan</i>'}
📞 Sumber      : ${sourceMap[d.source] || d.source || '<i>tidak disebutkan</i>'}
⏰ Waktu       : ${d.reported_time || '<i>tidak disebutkan</i>'}
📌 Tipe        : ${d.issue_type || '-'}

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
