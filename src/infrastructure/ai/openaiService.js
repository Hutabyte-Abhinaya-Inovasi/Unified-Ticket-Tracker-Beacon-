import { env } from "../../config/env.js";
import { getTicketById } from "../../database/supabase.js";
import { supabase } from "../../database/supabase.js";
import { client, AI_MODEL, callOpenAIChatCompletion, cleanJSON } from "./aiClient.js";
import { runPipeline } from "./pipeline/runPipeline.js";

const MAX_RETRY = 5;
const TABLE_NAME = "Unified_Ticket_Tracker";
const DEFAULT_QUERY_ROWS = 50;
const MAX_QUERY_ROWS = 100;

// ==================== TOOLS DEFINITION ====================
const tools = [
  {
    type: "function",
    function: {
      name: "get_ticket_detail",
      description: "Menampilkan detail lengkap SATU ticket berdasarkan ticket_id yang sudah diketahui secara pasti.",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Contoh: INC-20260430-0005" }
        },
        required: ["ticket_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_tickets",
      description:
        "Mengambil DAFTAR tiket dari database berdasarkan filter fleksibel (status, kategori, prioritas, subjek, rentang tanggal, kata kunci, assignee, source, action_needed). " +
        "Gunakan tool ini untuk pertanyaan umum yang TIDAK menyebutkan ticket_id secara spesifik, misalnya: " +
        "'apa tiket hari ini?', 'berapa tiket yang masih open?', 'ada masalah apa saja di server?', " +
        "'apa saja incident bulan ini?', 'siapa yang paling banyak mengerjakan tiket minggu ini?', 'apa update terbaru?', " +
        "'tiket dengan subjek Testing UTT', 'ceritakan detail tiket yang subjeknya soal VPN'. " +
        "Jika user menyebutkan JUDUL/SUBJEK tiket (bukan ticket_id), gunakan parameter 'subject' agar hasilnya presisi. " +
        "Setelah data mentah didapat, lakukan reasoning/agregasi/summarization sendiri untuk menjawab pengguna — termasuk detail spesifik seperti body, assignee, source, action_needed jika ditanya. " +
        "PENTING: hasil berisi field 'count' (jumlah PASTI seluruh baris yang cocok filter, dari database) dan 'tickets' (daftar baris, dibatasi oleh limit). " +
        "Untuk pertanyaan 'berapa/jumlah tiket ...', SELALU gunakan field 'count', JANGAN menghitung sendiri panjang array 'tickets' karena itu bisa terpotong oleh limit.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter status tiket. Nilai yang valid di database, pilih salah satu yang paling sesuai maksud user.",
            enum: ["Open", "In Progress", "Done", "Escalated", "Cancelled"]
          },
          category: {
            type: "string",
            description: "Filter kategori tiket. Nilai yang valid di database, pilih salah satu yang paling sesuai maksud user (mis. 'insiden'/'gangguan' → 'Incident Management', 'permintaan'/'request' → 'Service Request Management', 'perubahan'/'deploy' → 'Change Management', 'masalah berulang' → 'Problem Management').",
            enum: ["Incident Management", "Service Request Management", "Change Management", "Problem Management"]
          },
          priority: {
            type: "string",
            description: "Filter prioritas/severity tiket. Nilai yang valid di database, pilih salah satu yang paling sesuai maksud user (mis. 'urgent'/'darurat'/'kritis' → 'emergency', 'penting' → 'high', 'lambat'/'intermittent' → 'medium').",
            enum: ["emergency", "high", "medium", "low", "others"]
          },
          assignee: { type: "string", description: "Filter berdasarkan nama penanggung jawab tiket" },
          subject: { type: "string", description: "Cari tiket berdasarkan subjek/judul (partial match), contoh: 'Testing UTT'" },
          source: { type: "string", description: "Filter sumber tiket, contoh: 'email', 'whatsapp', 'telegram'" },
          action_needed: { type: "string", description: "Filter tindakan yang diperlukan pada tiket, sesuai isi kolom action_needed" },
          keyword: { type: "string", description: "Kata kunci bebas untuk dicari di subject/summary/body/category, contoh: 'server', 'VPN'" },
          date_from: { type: "string", description: "Batas awal tanggal (ISO 8601, contoh: '2026-07-14T00:00:00'), berdasarkan processed_at" },
          date_to: { type: "string", description: "Batas akhir tanggal (ISO 8601), berdasarkan processed_at" },
          order_by: {
            type: "string",
            description: "Kolom untuk pengurutan, default 'processed_at'",
            enum: ["processed_at", "priority", "status"]
          },
          limit: { type: "integer", description: `Jumlah maksimum baris yang diambil (default ${DEFAULT_QUERY_ROWS}, maksimum ${MAX_QUERY_ROWS})` }
        }
      }
    }
  }
];

// ==================== NORMALISASI SINONIM FILTER ====================
const PRIORITY_SYNONYMS = {
  urgent: "emergency", darurat: "emergency", kritis: "emergency", critical: "emergency", emergency: "emergency",
  tinggi: "high", high: "high", penting: "high",
  sedang: "medium", medium: "medium", menengah: "medium", lambat: "medium", intermittent: "medium",
  rendah: "low", low: "low", minor: "low",
  lainnya: "others", others: "others",
};

const CATEGORY_SYNONYMS = {
  incident: "Incident Management",
  insiden: "Incident Management",
  gangguan: "Incident Management",
  "incident management": "Incident Management",
  request: "Service Request Management",
  "service request": "Service Request Management",
  permintaan: "Service Request Management",
  "permintaan layanan": "Service Request Management",
  "service request management": "Service Request Management",
  change: "Change Management",
  perubahan: "Change Management",
  deploy: "Change Management",
  "change management": "Change Management",
  problem: "Problem Management",
  masalah: "Problem Management",
  "masalah berulang": "Problem Management",
  "problem management": "Problem Management",
};

const STATUS_SYNONYMS = {
  open: "Open", terbuka: "Open", baru: "Open",
  "in progress": "In Progress", diproses: "In Progress", proses: "In Progress", berjalan: "In Progress",
  done: "Done", selesai: "Done", beres: "Done", resolved: "Done",
  escalated: "Escalated", eskalasi: "Escalated", dieskalasi: "Escalated",
  cancelled: "Cancelled", canceled: "Cancelled", batal: "Cancelled", dibatalkan: "Cancelled",
};

function normalizeFilterValue(value, synonymMap) {
  if (!value) return value;
  const key = value.toString().trim().toLowerCase();
  return synonymMap[key] || value;
}

function applyTicketFilters(query, filters) {
  if (filters.status) {
    const normalized = normalizeFilterValue(filters.status, STATUS_SYNONYMS);
    query = query.ilike("status", `%${normalized}%`);
  }
  if (filters.category) {
    const normalized = normalizeFilterValue(filters.category, CATEGORY_SYNONYMS);
    query = query.ilike("category", `%${normalized}%`);
  }
  if (filters.priority) {
    const normalized = normalizeFilterValue(filters.priority, PRIORITY_SYNONYMS);
    query = query.ilike("priority", `%${normalized}%`);
  }
  if (filters.assignee) {
    query = query.ilike("assignee", `%${filters.assignee}%`);
  }
  if (filters.subject) {
    query = query.ilike("subject", `%${filters.subject}%`);
  }
  if (filters.source) {
    query = query.ilike("source", `%${filters.source}%`);
  }
  if (filters.action_needed) {
    query = query.ilike("action_needed", `%${filters.action_needed}%`);
  }
  if (filters.keyword) {
    const kw = `%${filters.keyword}%`;
    query = query.or(
      `subject.ilike.${kw},summary.ilike.${kw},body.ilike.${kw},category.ilike.${kw}`
    );
  }
  if (filters.date_from) {
    query = query.gte("processed_at", filters.date_from);
  }
  if (filters.date_to) {
    query = query.lte("processed_at", filters.date_to);
  }
  return query;
}

/**
 * Mengambil daftar tiket dengan filter dari Supabase.
 * Dipakai oleh tool `query_tickets` agar AI tidak lagi terbatas pada pencarian by ticket_id.
 */
async function queryTickets(filters = {}) {
  try {
    //  Hitung jumlah PASTI baris yang cocok filter (tidak terpengaruh limit)
    let countQuery = supabase
      .from(TABLE_NAME)
      .select("*", { count: "exact", head: true });
    countQuery = applyTicketFilters(countQuery, filters);
    const { count, error: countError } = await countQuery;

    if (countError) {
      console.error("❌ queryTickets count error:", countError.message);
      return { error: countError.message };
    }

    //  Ambil baris datanya (dibatasi limit) untuk detail/ringkasan
    let dataQuery = supabase.from(TABLE_NAME).select("*");
    dataQuery = applyTicketFilters(dataQuery, filters);

    const orderBy = filters.order_by || "processed_at";
    dataQuery = dataQuery.order(orderBy, { ascending: false });

    const limit = Math.min(
      Number(filters.limit) > 0 ? Number(filters.limit) : DEFAULT_QUERY_ROWS,
      MAX_QUERY_ROWS
    );
    dataQuery = dataQuery.limit(limit);

    const { data, error } = await dataQuery;

    if (error) {
      console.error("❌ queryTickets error:", error.message);
      return { error: error.message };
    }

    return {
      count: count ?? data.length, // JUMLAH PASTI — gunakan ini untuk pertanyaan "berapa/jumlah"
      returned: data.length,       // jumlah baris yang benar-benar dikirim (bisa < count jika terpotong limit)
      truncated: (count ?? 0) > data.length,
      tickets: data,
    };
  } catch (err) {
    console.error("❌ queryTickets exception:", err.message);
    return { error: err.message };
  }
}

async function getActiveTickets() {
  const result = await queryTickets({ status: "In Progress", limit: MAX_QUERY_ROWS });
  return result.tickets || [];
}

// ==================== EXECUTE TOOL ====================
async function executeTool(toolCall) {
  const functionName = toolCall.function.name;
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch (parseErr) {
    console.error(`Error parsing arguments for ${functionName}:`, parseErr.message);
    return { functionName, args, rawResult: { error: "Argumen tool tidak valid" } };
  }

  let rawResult;
  try {
    switch (functionName) {
      case "get_ticket_detail":
        rawResult = await getTicketById(args.ticket_id);
        break;

      case "query_tickets":
        rawResult = await queryTickets(args);
        break;


      default:
        rawResult = { error: `Aksi '${functionName}' tidak diizinkan. AI hanya bisa membaca data tiket (read-only), tidak bisa mengubah atau menghapus.` };
    }
  } catch (err) {
    console.error(`Error executing tool ${functionName}:`, err);
    rawResult = { error: err.message };
  }

  return { functionName, args, rawResult };
}

// ==================== HELPER ====================

function getJakartaDateInfo() {
  const now = new Date();

  const isoDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // contoh: 2026-07-14

  const readable = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now); 

  const time = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now); 

  const [y, m, d] = isoDate.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d));
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayIso = yesterday.toISOString().slice(0, 10);

  return { isoDate, readable, time, yesterdayIso };
}

// ==================== Agent RAG BERBASIS KATEGORI ====================

const CATEGORY_ALIASES = {
  "Incident Management": ["incident", "insiden", "gangguan", "error", "down", "mati"],
  "Service Request Management": ["service request", "permintaan layanan", "request", "akses", "password", "login"],
  "Change Management": ["change management", "perubahan", "deploy", "upgrade", "rilis"],
  "Problem Management": ["problem management", "berulang", "recurring", "akar masalah", "root cause"],
};

function detectRequestedCategory(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((alias) => lower.includes(alias))) {
      return category;
    }
  }
  return null;
}

async function retrieveDocumentsByCategory(category) {
  if (!category) return [];
  try {
    const { data, error } = await supabase
      .from("knowledge_base")
      .select("title, content, source, category")
      .eq("category", category)
      .limit(3);

    if (error) {
      console.warn(
        "⚠️ Retrieval berbasis kategori tidak aktif (kemungkinan kolom 'category' belum ada di tabel knowledge_base):",
        error.message
      );
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn("⚠️ Gagal mengambil dokumen berdasarkan kategori:", err.message);
    return [];
  }
}

// ==================== CHAT WITH AI ====================
async function chatWithAI(userInput, context = "") {
  // ─── LANGKAH RAG: RETRIEVAL ───
  let retrievedContext = "";
  try {
    // 0. Deteksi apakah user menyinggung kategori tertentu (rule-based, cepat)
    const detectedCategory = detectRequestedCategory(userInput);

    // 1. Buat embedding dari pertanyaan user + cari dokumen berbasis kategori (jika terdeteksi) SECARA PARALEL
    const [queryEmbedding, categoryDocuments] = await Promise.all([
      createEmbedding(userInput),
      retrieveDocumentsByCategory(detectedCategory),
    ]);

    let semanticDocuments = [];
    if (queryEmbedding) {
      // 2. Cari dokumen relevan di Supabase berdasarkan kemiripan makna (semantic search)
      const { data: documents, error } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_threshold: 0.75, // Tingkat kemiripan minimum
        match_count: 3         // Ambil 3 dokumen teratas
      });

      if (error) {
        console.error("❌ RAG search error:", error.message);
      } else if (documents && documents.length > 0) {
        semanticDocuments = documents;
      }
    }

    // 3. Gabungkan hasil semantic search + kategori, hilangkan duplikat berdasarkan title
    const combinedMap = new Map();
    semanticDocuments.forEach((doc) => combinedMap.set(doc.title, doc));
    categoryDocuments.forEach((doc) => {
      if (!combinedMap.has(doc.title)) combinedMap.set(doc.title, doc);
    });
    const allDocuments = [...combinedMap.values()];

    if (allDocuments.length > 0) {
      console.log(
        `📚 RAG: ${semanticDocuments.length} dokumen dari semantic search` +
        (detectedCategory ? `, ${categoryDocuments.length} dokumen dari kategori "${detectedCategory}"` : "") +
        ` (total unik: ${allDocuments.length}).`
      );
      retrievedContext = "Berikut adalah beberapa konteks dari knowledge base yang mungkin relevan" +
        (detectedCategory ? ` (termasuk yang berkategori "${detectedCategory}")` : "") + ":\n\n" +
        allDocuments.map(doc => `--- Dokumen: ${doc.title} ---\n${doc.content}`).join("\n\n");
    }
  } catch (ragError) {
    console.error("❌ Kesalahan pada proses RAG:", ragError.message);
  }

  // ─── LANGKAH AUGMENTATION & GENERATION ───
  const { isoDate, readable, time, yesterdayIso } = getJakartaDateInfo();

  let messages = [
    {
      role: "system",
      content: `Anda adalah AI Assistant "Beacon", asisten ITSM yang cerdas, sopan, dan terhubung dengan basis data operasional (tiket, insiden, knowledge base) di Supabase.

### Informasi Waktu Saat Ini (WAJIB DIPAKAI, JANGAN GUNAKAN TANGGAL LAIN)
- Sekarang: ${readable}, pukul ${time} WIB
- Tanggal hari ini (format YYYY-MM-DD): ${isoDate}
- Tanggal kemarin (format YYYY-MM-DD): ${yesterdayIso}
- SELALU hitung "hari ini", "kemarin", "minggu ini", "bulan ini", dsb berdasarkan tanggal di atas. JANGAN PERNAH menggunakan tanggal dari pengetahuan internal/training Anda — tanggal tersebut sudah usang dan SALAH.
- Saat memanggil tool \`query_tickets\` dengan filter \`date_from\`/\`date_to\`, gunakan format ISO penuh berdasarkan tanggal di atas, contoh untuk "kemarin": date_from = "${yesterdayIso}T00:00:00", date_to = "${yesterdayIso}T23:59:59".

### Cara Membaca Hasil Tool (PENTING — sudah melalui pipeline validasi)
Setiap kali Anda memanggil tool (\`get_ticket_detail\`, \`query_tickets\`), hasil yang Anda terima BUKAN data mentah dari Supabase — data tersebut sudah melewati pipeline validasi berlapis (Data Validation → Data Auditor → Business Logic Checker → Context Builder) sebelum sampai ke Anda. Bentuknya selalu seperti ini:
{
  "tool": "nama tool",
  "arguments": { ...argumen yang dipakai... },
  "data": { ...data asli hasil query, contoh untuk query_tickets: { count, returned, truncated, tickets } ... },
  "pipeline_meta": {
    "validation": { "valid": bool, "is_empty": bool, "is_error": bool, "issues": [...] },
    "audit": { "consistent": bool, "confidence_score": 0-100, "inconsistencies": [...] },
    "business_logic": { "compliant": bool, "violations": [...], "needs_more_data": bool, "additional_data_needed": ... }
  },
  "guidance_for_main_model": "rekomendasi singkat cara merespons"
}
Aturan wajib:
- SELALU baca \`guidance_for_main_model\` dan \`pipeline_meta\` sebelum menyusun jawaban.
- Kalau \`pipeline_meta.validation.is_error\` = true → sampaikan ke user bahwa ada kendala teknis mengambil data, JANGAN mengarang jawaban.
- Kalau \`pipeline_meta.audit.confidence_score\` < 50 → sampaikan jawaban dengan hati-hati dan sebutkan ada ketidakpastian pada data.
- Kalau \`pipeline_meta.business_logic.violations\` tidak kosong → pertimbangkan menyampaikan catatan tersebut ke user jika relevan.
- Kalau \`pipeline_meta.business_logic.needs_more_data\` = true → pertimbangkan memanggil tool lain untuk melengkapi data sebelum menjawab final.
- Data asli (untuk dijawabkan ke user) selalu ada di dalam field \`data\`, bukan di level teratas.

### Tugas Utama
1. Selalu gunakan data dari Supabase (lewat field \`data\` pada hasil tool) sebagai sumber informasi utama. Jangan pernah mengasumsikan atau menciptakan informasi.
2. Pahami intent pengguna terlebih dahulu — pengguna bisa bertanya secara bebas mengenai seluruh knowledge base, tidak hanya berdasarkan nomor tiket.
3. Tentukan data apa yang perlu diambil dari Supabase, lalu lakukan retrieval terhadap SELURUH data yang relevan (bukan hanya berdasarkan ticket_id).
4. Setelah data diperoleh DAN sudah dicek lewat \`pipeline_meta\`, lakukan reasoning, agregasi, atau summarization untuk menghasilkan jawaban yang akurat dan informatif.
5. Jika data relevan tidak ditemukan di Supabase, jelaskan dengan sopan bahwa informasi tersebut tidak tersedia.

### Tools yang Tersedia
- \`get_ticket_detail\`: gunakan HANYA jika pengguna menyebutkan satu ticket_id spesifik.
- \`query_tickets\`: gunakan untuk pertanyaan umum/bebas yang TIDAK menyebutkan ticket_id — filter berdasarkan status, kategori, prioritas, assignee, subject, source, action_needed, kata kunci, atau rentang tanggal. Contoh: "apa tiket hari ini?", "berapa tiket yang masih open?", "ada masalah apa saja di server?", "siapa yang paling banyak mengerjakan tiket minggu ini?", "tiket dengan subjek Testing UTT hari ini".
- \`update_ticket\` dan \`delete_ticket\` TIDAK TERSEDIA dan TIDAK BOLEH dipanggil. Anda HANYA memiliki akses baca (read-only) ke data tiket. Jika user meminta mengubah status, mengedit field, atau menghapus tiket, TOLAK dengan sopan dan jelaskan bahwa perubahan/penghapusan data harus dilakukan langsung oleh tim terkait melalui sistem/akses yang sesuai — bukan lewat AI ini.
- Konteks RAG di bawah (jika ada) adalah sumber utama untuk pertanyaan seputar knowledge base, SOP, atau solusi teknis. Konteks ini sudah menggabungkan hasil pencarian semantik (kemiripan makna pertanyaan) DAN pencarian berbasis kategori tiket (kalau pertanyaan Anda menyinggung kategori tertentu seperti Incident/Problem/Change/Service Request Management) — jadi tidak perlu lagi mengandalkan tool untuk mengambil dokumen KB, cukup pakai konteks yang sudah disediakan.

### Struktur Data Tiket (tabel Unified_Ticket_Tracker)
Setiap tiket punya kolom: \`subject\` (judul/subjek tiket), \`body\` (isi/detail lengkap laporan), \`summary\` (ringkasan), \`category\`, \`assignee\` (penanggung jawab), \`status\`, \`processed_at\` (waktu tiket diproses — dipakai untuk semua filter tanggal), \`action_needed\` (tindakan yang diperlukan), \`source\` (asal laporan: email/whatsapp/telegram/dll), \`priority\`.
Catatan: tabel ini TIDAK punya kolom nama pelapor terpisah — jika user menanyakan "siapa yang lapor" atau nama orang tertentu, jawab berdasarkan apa yang tertulis di \`body\`/\`summary\` (jika disebutkan di sana); jika tidak ada, sampaikan dengan jujur bahwa informasi itu tidak tercatat di data.

Nilai valid untuk filter (pakai salah satu dari daftar ini bila memungkinkan):
- \`priority\`: emergency, high, medium, low, others
- \`category\`: Incident Management, Service Request Management, Change Management, Problem Management
- \`status\`: Open, In Progress, Done, Escalated, Cancelled

Jika user memakai istilah lain (misal "urgent"/"darurat"/"kritis" untuk priority, "insiden"/"gangguan" untuk category, "selesai"/"beres" untuk status), petakan dulu ke nilai valid di atas sebelum memanggil \`query_tickets\` — sistem juga sudah punya jaring pengaman normalisasi sinonim + pencarian partial, jadi query TIDAK akan gagal total hanya karena beda kata, tapi hasil paling akurat kalau Anda kirim nilai kanonik di atas.

### Aturan Retrieval
Sesuaikan filter \`query_tickets\` dengan isi pertanyaan, contoh:
- "Apa tiket hari ini?" → filter tanggal hari ini (berdasarkan processed_at).
- "Berapa tiket yang masih open?" → filter status Open.
- "Siapa yang paling banyak mengerjakan tiket minggu ini?" → ambil tiket minggu ini, lalu agregasikan berdasarkan assignee.
- "Ada masalah apa saja di server?" → filter keyword "server".
- "Apa saja incident bulan ini?" → filter kategori Incident + rentang tanggal bulan berjalan.
- "Ada issue penting?" → filter priority High/Critical dan status belum selesai.
- "Apa update terbaru?" → urutkan berdasarkan processed_at.
- "Tiket dengan subjek Testing UTT hari ini" → filter \`subject\` = "Testing UTT" DAN rentang tanggal hari ini, lalu jawab dengan detail lengkap (body, assignee, status, priority, action_needed, source) dari tiket yang ditemukan.

### Aturan Jawaban
- Jawaban harus selalu berdasarkan data hasil retrieval (\`data\` pada hasil tool), jangan mengarang informasi.
- Untuk pertanyaan detail spesifik tentang satu tiket (subjek, isi laporan, siapa yang menangani, prioritas, dll), sertakan semua kolom relevan yang tersedia di baris tiket tersebut.
- Untuk pertanyaan "berapa/jumlah tiket ...", gunakan field \`data.count\` (jumlah pasti dari database), BUKAN menghitung sendiri panjang daftar \`data.tickets\` yang dikembalikan (daftar itu dibatasi jumlahnya).
- Jika data terlalu banyak, tampilkan ringkasan terlebih dahulu, lalu tawarkan detail lebih lanjut jika diminta.
- Gunakan bahasa Indonesia yang profesional dan selalu siap membantu.

${retrievedContext}`
    },
    { role: "user", content: userInput + context }
  ];

  let attempt = 0;

  while (attempt < MAX_RETRY) {
    try {
      const response = await callOpenAIChatCompletion({
        model: AI_MODEL,
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 800,
      });

      const message = response.choices[0]?.message;

      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          const { functionName, args, rawResult } = await executeTool(toolCall);

          // ─── PIPELINE VALIDASI BERLAPIS (Agent 1-4) ───
          // Data mentah dari Supabase TIDAK langsung dikirim ke Main Model.
          // Harus lewat: Data Validation → Data Auditor → Business Logic Checker → Context Builder.
          const validatedContext = await runPipeline(functionName, args, rawResult);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(validatedContext)
          });
        }
        continue;
      }

      return message.content?.trim() || "Maaf, saya tidak mengerti perintah tersebut.";

    } catch (err) {
      attempt++;
      console.error("OpenAI Chat Error:", err.message);
      if (attempt >= MAX_RETRY) {
        return "Maaf, terjadi kesalahan saat memproses permintaan. Silakan coba lagi.";
      }
    }
  }
}

// Fungsi baru untuk membuat embedding
async function createEmbedding(text) {
  // Pastikan teks tidak kosong dan bersihkan
  const cleanText = text.replace(/\n/g, ' ');
  try {
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small', // Model embedding dari OpenAI
      input: cleanText,
      dimensions: 1536 // Sesuaikan dengan ukuran di tabel Supabase
    });
    return response.data[0].embedding;
  } catch (err) {
    console.error("❌ Gagal membuat embedding:", err.message);
    return null;
  }
}

/**
 * Mengindeks sebuah dokumen ke knowledge base, opsional dengan tag `category`
 * (harus salah satu dari kategori resmi: Incident Management, Service Request Management,
 * Change Management, Problem Management) supaya bisa ikut ditemukan oleh retrieval
 * berbasis kategori di chatWithAI, selain lewat semantic search seperti biasa.
 *
 * Kalau kolom `category` belum ada di tabel `knowledge_base` (migrasi belum dijalankan),
 * insert akan otomatis dicoba ulang TANPA field category, supaya indexing tetap jalan
 * dan tidak gagal total hanya karena fitur kategori belum diaktifkan.
 */
export async function indexDocument(title, content, source = 'manual', category = null) {
  console.log(`📚 Mengindeks dokumen: "${title}"${category ? ` (kategori: ${category})` : ""}`);
  const embedding = await createEmbedding(content);
  if (!embedding) return;

  const payload = { title, content, source, embedding };
  if (category) payload.category = category;

  const { error } = await supabase.from('knowledge_base').insert(payload);

  if (error && category) {
    console.warn(`⚠️ Insert dengan category gagal (kemungkinan kolom belum ada), mencoba tanpa category:`, error.message);
    const { error: fallbackError } = await supabase.from('knowledge_base').insert({ title, content, source, embedding });
    if (fallbackError) console.error(`❌ Gagal menyimpan indeks:`, fallbackError.message);
    else console.log(`   ✅ Dokumen berhasil diindeks (tanpa category — jalankan migrasi untuk mengaktifkan fitur kategori).`);
    return;
  }

  if (error) console.error(`❌ Gagal menyimpan indeks:`, error.message);
  else console.log(`   ✅ Dokumen berhasil diindeks.`);
}

// ==================== ANALYZE EMAIL (untuk WhatsApp) ====================
async function analyzeEmail(email) {
  const fullText = `${email.subject} ${email.body}`.trim();

  if (isSmallTalk(fullText)) {
    console.log("🟡 Pesan diabaikan (small talk):", fullText.substring(0, 60));
    return {
      shouldProcess: false,
      isRelevant: false,
      confidence_score: 0,
      reason: "small_talk",
      original_message: email.body,
      subject: email.subject,
      category: null,
      priority: null,
      response: null,
    };
  }

  const safeBody = limitText(email.body);
  const safeSubject = limitText(email.subject, 300);
  const ruleResult = detectByRules(fullText);

  if (ruleResult.priority === "CRITICAL") {
    return {
      shouldProcess: true,
      isRelevant: true,
      confidence_score: 100,
      original_message: email.body,
      subject: email.subject,
      category: ruleResult.category,
      priority: "CRITICAL",
      response: "Tim kami sedang menangani masalah ini secepat mungkin.",
    };
  }

  const prompt = `
Anda adalah AI ITSM yang cerdas dan teliti.

Tugas Anda:
- Analisis pesan dari WhatsApp Group / Telegram / Email
- Tentukan apakah pesan ini perlu ditindaklanjuti sebagai tiket ITSM atau hanya obrolan biasa
- Jika tidak relevan, set "isRelevant": false

Balas HANYA dengan JSON valid ini, tanpa penjelasan tambahan:

{
  "isRelevant": true atau false,
  "confidence_score": 0-100,
  "original_message": "salinan pesan asli dari user (jangan diringkas)",
  "category": "Incident Management | Problem Management | Change Management | Service Request Management",
  "severity": "emergency | high | medium | low | others",
  "response": "balasan profesional yang sopan (kosongkan jika isRelevant = false)"
}

*Catatan untuk confidence_score: Berikan nilai 0-100 (integer) untuk mewakili seberapa yakin Anda bahwa pesan ini adalah masalah teknis/permintaan layanan riil yang membutuhkan penanganan tim support (sebagai tiket).

EMAIL:
Subject: ${safeSubject}
Body:
${safeBody}
`;

  // Dideklarasikan di luar try agar tetap bisa diakses dari blok catch untuk logging.
  let text = "";

  try {
    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "Anda adalah AI ITSM yang akurat. Selalu kembalikan pesan asli tanpa diringkas. Jawab hanya dengan JSON."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 600,
      temperature: 0.1,
    });

    text = response.choices[0]?.message?.content || "";
    text = cleanJSON(text);

    const parsed = JSON.parse(text);

    return {
      shouldProcess: parsed.isRelevant !== false,
      isRelevant: parsed.isRelevant !== false,
      confidence_score: parsed.confidence_score !== undefined ? Number(parsed.confidence_score) : 100,
      original_message: parsed.original_message || email.body,
      subject: email.subject,
      category: parsed.category || ruleResult.category,
      priority: parsed.severity || ruleResult.priority,
      response: parsed.response || null,
      reason: parsed.isRelevant === false ? "ai_filtered" : "processed",
    };

  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn("❌ JSON parse error dari AI. Menganggap tidak relevan.", text);
    } else {
      console.error("OpenAI Error:", err.message);
    }
    // Fallback jika AI gagal: anggap tidak relevan agar tidak membuat tiket yang salah.
    return {
      shouldProcess: false,
      isRelevant: false,
      confidence_score: 0,
      reason: "ai_parsing_failed",
      original_message: email.body,
      subject: email.subject,
      category: ruleResult.category,
      priority: ruleResult.priority,
      response: null,
    };
  }
}

// ==================== EXTRACT TICKET FIELDS (untuk Manual Input Telegram) ====================
/**
 * Ekstrak field tiket dari teks bebas menggunakan AI.
 * Dipanggil saat user kirim teks bebas setelah /tiket baru.
 * @param {string} rawText - Teks bebas dari user
 * @returns {Object} - Object berisi field yang berhasil diekstrak
 */
async function extractTicketFields(rawText) {
  const prompt = `
Kamu adalah AI ITSM yang bertugas mengekstrak informasi tiket dari teks bebas.

Dari teks berikut, ekstrak informasi dan kembalikan HANYA JSON valid (tanpa penjelasan tambahan):

{
  "project": "nama project yang terdampak, pilih salah satu: Single Mediation | Message Broker | APH Mediation | Unified Network Mediation | Umbrella SIEM | Enterprise Product Catalog | B2B Service Surveillance | Device Management | CDR & LUADR | Others (null jika tidak disebutkan)",
  "requester": "nama orang yang melaporkan masalah (null jika tidak disebutkan)",
  "source": "sumber tiket: email | telepon | whatsapp | walk-in | telegram | lainnya (null jika tidak jelas)",
  "reported_time": "waktu kejadian atau waktu dilaporkan dalam format HH:MM WIB atau deskripsi relatif seperti 'tadi pagi' (null jika tidak disebutkan)",
  "category": "Incident Management | Service Request Management | Change Management | Problem Management (pilih yang paling sesuai)",
  "issue_type": "Change Management | Incident Management | Knowledge Management | Problem Management | Relationship Management | Service Request Management (pilih yang paling sesuai)",
  "severity": "emergency | high | medium | low | others",
  "description": "ringkasan masalah dalam 1-3 kalimat yang jelas dan informatif"
}

Aturan severity:
- emergency: server down total, tidak bisa diakses sama sekali, production mati, darurat
- high: error kritis, gagal, tidak bisa login, fitur utama rusak
- medium: lambat, intermittent, sebagian fitur bermasalah
- low: pertanyaan, informasi, permintaan minor
- others: tidak termasuk kategori di atas

TEKS:
${rawText}
`;

  try {
    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "Kamu adalah AI ITSM yang akurat. Jawab hanya dengan JSON valid, tanpa markdown, tanpa penjelasan."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.1,
    });

    let text = response.choices[0]?.message?.content || "{}";
    text = cleanJSON(text);
    const parsed = JSON.parse(text);

    // Normalisasi nilai
    const validCategories = [
      "Incident Management",
      "Service Request Management",
      "Change Management",
      "Problem Management"
    ];
    const validIssueTypes = [
      "Change Management",
      "Incident Management",
      "Knowledge Management",
      "Problem Management",
      "Relationship Management",
      "Service Request Management"
    ];
    const validProjects = [
      "Single Mediation", "Message Broker", "APH Mediation",
      "Unified Network Mediation", "Umbrella SIEM", "Enterprise Product Catalog",
      "B2B Service Surveillance", "Device Management", "CDR & LUADR", "Others"
    ];
    const validSources = ["email", "telepon", "whatsapp", "walk-in", "telegram", "lainnya"];

    return {
      project: validProjects.includes(parsed.project) ? parsed.project : (parsed.project || null),
      requester: parsed.requester || null,
      source: validSources.includes((parsed.source || "").toLowerCase()) ? parsed.source.toLowerCase() : null,
      reported_time: parsed.reported_time || null,
      category: validCategories.includes(parsed.category) ? parsed.category : "Incident Management",
      issue_type: validIssueTypes.includes(parsed.issue_type) ? parsed.issue_type : "Incident Management",
      severity: null, // Dipaksa null agar selalu dipilih manual oleh user
      description: parsed.description || rawText.substring(0, 300),
    };

  } catch (err) {
    console.error("❌ extractTicketFields error:", err.message);
    // Fallback: kembalikan data minimal dari rules
    const ruleResult = detectByRules(rawText);
    return {
      project: null,
      requester: null,
      source: null,
      reported_time: null,
      category: ruleResult.category,
      issue_type: "Incident Management",
      severity: null, // Dipaksa null agar selalu dipilih manual oleh user
      description: rawText.substring(0, 300),
    };
  }
}

export function isSmallTalk(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // 1. Cek apakah ada kata kunci keluhan/permintaan IT (jika ada, PASTI bukan small talk!)
  const actionOrTechWords = /(perbaiki|benerin|rusak|error|mati|down|server|web|jaringan|wifi|lambat|lemot|gagal|gabisa|gak bisa|tidak bisa|bantu|tolong|cek|issue|bug|ticket|tiket|kendala|masalah|trouble|putus|absen|login|password)/i;
  if (actionOrTechWords.test(trimmed)) {
    return false;
  }

  // 2. Daftar pola sapaan atau jawaban pendek polos yang tidak mengandung keluhan 
  // update terakhir 23 juli 
  const IRRELEVANT_PATTERNS = [
    /^(hai+|halo+|hi+|hello+|pagi|siang|sore|malam)$/i,
    /^(terima kasih|thanks|thank you|makasih|tq|thx)$/i,
    /^(sama-sama|ok|oke|sip|mantap|siap|baik)$/i,
    /^(sudah|done|selesai|beres)$/i,
    /^(apa kabar\??|kabar)$/i,
    /^(ya|iya|betul|benar|nggak|tidak)$/i,
  ];

  for (const pattern of IRRELEVANT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // 3. Jika pesan sangat pendek (< 10 karakter) dan tidak ada kata teknis/keluhan
  if (trimmed.length < 10) {
    return true;
  }

  return false;
}

function limitText(text, max = 2500) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function detectByRules(text) {
  const lowerText = text.toLowerCase();
  let priority = "medium";
  let category = "Service Request Management";

  const PRIORITY_RULES = [
    { keyword: ["down", "server mati", "tidak bisa diakses", "mati total", "offline"], priority: "emergency" },
    { keyword: ["error", "failed", "gagal", "tidak bisa", "crash"], priority: "high" },
    { keyword: ["lambat", "slow", "lemot", "delay"], priority: "medium" },
  ];

  const CATEGORY_RULES = [
    { keyword: ["password", "login", "akses", "tidak bisa masuk"], category: "Service Request Management" },
    { keyword: ["error", "bug", "failure", "crash", "broke", "issue"], category: "Incident Management" },
    { keyword: ["perubahan", "update", "upgrade", "deploy"], category: "Change Management" },
    { keyword: ["berulang", "sering terjadi", "repeated"], category: "Problem Management" },
  ];

  for (const rule of PRIORITY_RULES) {
    if (rule.keyword.some(k => lowerText.includes(k))) {
      priority = rule.priority;
      break;
    }
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.keyword.some(k => lowerText.includes(k))) {
      category = rule.category;
      break;
    }
  }

  return { severity: priority, category };
}

async function checkMessageRelevance(newMessage, activeTicketBody, activeTicketSummary) {
  try {
    const prompt = `Anda adalah asisten triase operasional IT.
Tugas Anda adalah menentukan apakah pesan baru dari chat grup membahas insiden/permohonan yang sama dengan tiket aktif yang sedang berjalan, atau merupakan laporan masalah baru yang sama sekali tidak berhubungan.

Tiket Aktif Saat Ini:
Ringkasan: ${activeTicketSummary || 'Tidak ada'}
Pesan Awal/Detail: ${activeTicketBody || 'Tidak ada'}

Pesan Baru yang Masuk:
"${newMessage}"

Silakan analisis apakah Pesan Baru ini membahas insiden yang sama atau merupakan balasan (follow-up/pertanyaan/konfirmasi) dari Tiket Aktif.
Jika pesan baru membahas topik baru yang berbeda (misal: tiket aktif membahas login error, tapi pesan baru membahas AC bocor atau printer rusak), maka isRelated harus false.
Jika pesan baru adalah balasan singkat ("oke pak", "tolong diproses", "siap", dll) atau masih menanyakan/melaporkan kelanjutan dari tiket aktif, maka isRelated harus true.

Keluarkan hasil analisis dalam format JSON valid berikut:
{
  "isRelated": true atau false,
  "reason": "Alasan singkat analisis Anda dalam bahasa Indonesia"
}`;

    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "Anda hanya menjawab dengan format JSON valid." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const resultText = response.choices[0].message.content;
    const cleanResult = cleanJSON(resultText);
    const result = JSON.parse(cleanResult);

    console.log(`🧠 AI Relevance Check: isRelated = ${result.isRelated} (${result.reason})`);
    return !!result.isRelated;
  } catch (err) {
    console.error("❌ Gagal mengecek relevansi pesan dengan AI:", err.message);
    // Fallback aman: jika gagal, anggap terkait agar tidak membuat tiket duplikat secara tidak sengaja
    return true;
  }
}

async function routeMessageToActiveTickets(newMessage, activeTickets) {
  try {
    const ticketListStr = activeTickets.map((t, idx) => {
      return `Ticket [${idx + 1}]:
ID: ${t.ticket_id}
Summary: ${t.summary || 'Tidak ada'}
Detail/Body: ${t.body || 'Tidak ada'}
--------------------`;
    }).join('\n');

    const prompt = `Anda adalah asisten triase operasional IT.
Pesan baru masuk dari chat grup:
"${newMessage}"

Berikut adalah daftar tiket aktif yang saat ini terbuka di grup chat ini:
${ticketListStr}

Tugas Anda:
1. Analisis apakah pesan baru tersebut merupakan kelanjutan, pertanyaan, konfirmasi, atau balasan yang relevan dengan salah satu tiket aktif di atas.
2. Jika pesan baru membahas topik yang sama dengan salah satu tiket aktif, tentukan "relatedTicketId" berisi ID tiket tersebut (misal: "TG-1782713833972").
3. Jika pesan baru membahas topik baru yang tidak ada hubungannya dengan tiket-tiket aktif di atas, maka "relatedTicketId" harus null.

Keluarkan hasil analisis dalam format JSON valid berikut:
{
  "relatedTicketId": "ID-TIKET-YANG-COCOK" atau null,
  "reason": "Alasan singkat analisis Anda dalam bahasa Indonesia"
}`;

    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "Anda hanya menjawab dengan format JSON valid." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const resultText = response.choices[0].message.content;
    const cleanResult = cleanJSON(resultText);
    const result = JSON.parse(cleanResult);

    console.log(`🧠 AI Multi-Topic Router: matched = ${result.relatedTicketId} (${result.reason})`);
    return result.relatedTicketId || null;
  } catch (err) {
    console.error("❌ Gagal merutekan pesan dengan AI:", err.message);
    return null;
  }
}

async function detectStatusChangeFromReply(text) {
  try {
    const prompt = `Anda adalah asisten triase operasional IT.
Tugas Anda adalah menganalisis isi pesan balasan dari tim teknis/support IT untuk mendeteksi apakah pesan tersebut menyatakan bahwa tiket/masalah sudah selesai, dibatalkan, atau perlu dieskalasi.

Pesan:
"${text}"

Tentukan status baru berdasarkan analisis Anda. Pilihan status yang valid:
- "Done" (jika masalah dinyatakan selesai, teratasi, sukses dikerjakan, ok aman, dll. Contoh: "sudah selesai pak", "aman pak", "sudah beres", "solved")
- "Escalated" (jika masalah perlu diteruskan ke level lebih tinggi, dilaporkan ke pihak lain, dll. Contoh: "ini perlu dieskalasi ke tim infra", "kami laporkan ke L3")
- "Cancelled" (jika masalah dibatalkan, salah lapor, dll. Contoh: "batal pak", "cancel saja")
- "no_change" (jika pesan adalah diskusi biasa dan tidak menyatakan perubahan status operasional)

Keluarkan hasil dalam format JSON valid berikut:
{
  "newStatus": "Done" | "Escalated" | "Cancelled" | "no_change",
  "reason": "Alasan analisis Anda dalam bahasa Indonesia"
}`;

    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "Anda hanya menjawab dengan format JSON valid." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const resultText = response.choices[0].message.content;
    const cleanResult = cleanJSON(resultText);
    const result = JSON.parse(cleanResult);

    console.log(`🧠 AI Status Detector: detected = ${result.newStatus} (${result.reason})`);
    return result.newStatus || "no_change";
  } catch (err) {
    console.error("❌ Gagal mendeteksi status tiket dari balasan dengan AI:", err.message);
    return "no_change";
  }
}

export {
  getActiveTickets,
  queryTickets,
  getJakartaDateInfo,
  chatWithAI,
  analyzeEmail,
  checkMessageRelevance,
  routeMessageToActiveTickets,
  detectStatusChangeFromReply,
  extractTicketFields
};