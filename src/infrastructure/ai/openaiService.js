// src/infrastructure/ai/openaiService.js
import OpenAI from "openai";
import { env } from "../../config/env.js";
import {
  getTicketById,
  updateTicket,
  deleteTicket
} from "../../database/supabase.js";
import { supabase } from "../../database/supabase.js";

const isGemini = !!env.GEMINI_API_KEY;

const client = new OpenAI({
  apiKey: env.GEMINI_API_KEY || env.OPENAI_API_KEY,
  baseURL: isGemini ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined,
});
// Model untuk chat completion
const AI_MODEL = isGemini ? "gemini-2.5-flash" : "gpt-4o-mini";

const MAX_RETRY = 5;
const TABLE_NAME = "Unified_Ticket_Tracker";
const MAX_QUERY_ROWS = 100;
const DEFAULT_QUERY_ROWS = 50;

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
        "Mengambil DAFTAR tiket dari database berdasarkan filter fleksibel (status, kategori, prioritas, rentang tanggal, kata kunci, assignee). " +
        "Gunakan tool ini untuk pertanyaan umum yang TIDAK menyebutkan ticket_id secara spesifik, misalnya: " +
        "'apa tiket hari ini?', 'berapa tiket yang masih open?', 'ada masalah apa saja di server?', " +
        "'apa saja incident bulan ini?', 'siapa yang paling banyak mengerjakan tiket minggu ini?', 'apa update terbaru?'. " +
        "Setelah data mentah didapat, lakukan reasoning/agregasi/summarization sendiri untuk menjawab pengguna. " +
        "PENTING: hasil berisi field 'count' (jumlah PASTI seluruh baris yang cocok filter, dari database) dan 'tickets' (daftar baris, dibatasi oleh limit). " +
        "Untuk pertanyaan 'berapa/jumlah tiket ...', SELALU gunakan field 'count', JANGAN menghitung sendiri panjang array 'tickets' karena itu bisa terpotong oleh limit.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter status persis, contoh: 'Open', 'In Progress', 'Done', 'Escalated', 'Cancelled'" },
          category: { type: "string", description: "Filter kategori, contoh: 'Incident Management', 'Change Management'" },
          priority: { type: "string", description: "Filter prioritas/severity, contoh: 'emergency', 'high', 'medium', 'low'" },
          assignee: { type: "string", description: "Filter berdasarkan nama penanggung jawab tiket" },
          keyword: { type: "string", description: "Kata kunci bebas untuk dicari di ringkasan/deskripsi tiket, contoh: 'server', 'VPN'" },
          date_from: { type: "string", description: "Batas awal tanggal (ISO 8601, contoh: '2026-07-14T00:00:00'), berdasarkan created_at" },
          date_to: { type: "string", description: "Batas akhir tanggal (ISO 8601), berdasarkan created_at" },
          order_by: {
            type: "string",
            description: "Kolom untuk pengurutan, default 'created_at'",
            enum: ["created_at", "updated_at", "priority", "status"]
          },
          limit: { type: "integer", description: `Jumlah maksimum baris yang diambil (default ${DEFAULT_QUERY_ROWS}, maksimum ${MAX_QUERY_ROWS})` }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_ticket",
      description: "Mengupdate data ticket (status, priority, category, dll)",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket ID yang akan diupdate" },
          updates: {
            type: "object",
            description: "Object berisi field yang ingin diubah, contoh: {status: 'Done', priority: 'HIGH'}"
          }
        },
        required: ["ticket_id", "updates"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_ticket",
      description: "Menghapus sebuah ticket dari database",
      parameters: {
        type: "object",
        properties: {
          ticket_id: { type: "string", description: "Ticket ID yang akan dihapus" }
        },
        required: ["ticket_id"]
      }
    }
  }
];

// ==================== QUERY TICKETS (Flexible Retrieval) ====================
/**
 * Menerapkan filter yang sama ke sebuah query builder Supabase.
 * Dipakai bersama baik untuk query data maupun query exact count,
 * supaya keduanya selalu konsisten memfilter baris yang sama.
 */
function applyTicketFilters(query, filters) {
  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.category) {
    query = query.eq("category", filters.category);
  }
  if (filters.priority) {
    query = query.eq("priority", filters.priority);
  }
  if (filters.assignee) {
    query = query.ilike("assignee", `%${filters.assignee}%`);
  }
  if (filters.keyword) {
    const kw = `%${filters.keyword}%`;
    // Cari di beberapa kolom teks sekaligus
    query = query.or(
      `summary.ilike.${kw},description.ilike.${kw},body.ilike.${kw},category.ilike.${kw}`
    );
  }
  if (filters.date_from) {
    query = query.gte("created_at", filters.date_from);
  }
  if (filters.date_to) {
    query = query.lte("created_at", filters.date_to);
  }
  return query;
}

/**
 * Mengambil daftar tiket dengan filter fleksibel dari Supabase.
 * Dipakai oleh tool `query_tickets` agar AI tidak lagi terbatas pada pencarian by ticket_id.
 *
 * PENTING: `count` di hasil adalah JUMLAH PASTI (exact count dari Supabase) berdasarkan
 * SELURUH baris yang cocok filter — bukan sekadar panjang array `tickets` yang dikembalikan.
 * Ini karena `tickets` dibatasi oleh `limit` (maks 100 baris) agar tidak membebani konteks AI,
 * sedangkan pertanyaan seperti "berapa jumlah tiket..." butuh angka yang akurat meskipun
 * jumlah baris yang cocok lebih besar dari limit tersebut.
 */
async function queryTickets(filters = {}) {
  try {
    // 1. Hitung jumlah PASTI baris yang cocok filter (tidak terpengaruh limit)
    let countQuery = supabase
      .from(TABLE_NAME)
      .select("*", { count: "exact", head: true });
    countQuery = applyTicketFilters(countQuery, filters);
    const { count, error: countError } = await countQuery;

    if (countError) {
      console.error("❌ queryTickets count error:", countError.message);
      return { error: countError.message };
    }

    // 2. Ambil baris datanya (dibatasi limit) untuk detail/ringkasan
    let dataQuery = supabase.from(TABLE_NAME).select("*");
    dataQuery = applyTicketFilters(dataQuery, filters);

    const orderBy = filters.order_by || "created_at";
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
    return { error: "Argumen tool tidak valid" };
  }

  try {
    switch (functionName) {
      case "get_ticket_detail":
        return await getTicketById(args.ticket_id);

      case "query_tickets":
        return await queryTickets(args);

      case "update_ticket":
        return await updateTicket(args.ticket_id, args.updates);

      case "delete_ticket":
        return await deleteTicket(args.ticket_id);

      default:
        return { error: "Function tidak dikenal" };
    }
  } catch (err) {
    console.error(`Error executing tool ${functionName}:`, err);
    return { error: err.message };
  }
}

// ==================== CALL OPENAI WITH RETRY ====================
async function callOpenAIChatCompletion(options) {
  let attempt = 0;
  while (attempt < MAX_RETRY) {
    try {
      return await client.chat.completions.create(options);
    } catch (err) {
      attempt++;
      if ((err.status === 429 || err.code === "rate_limit_exceeded") && attempt < MAX_RETRY) {
        const wait = 2000 * attempt;
        console.warn(`⏳ Rate Limit - Retry ${attempt}/${MAX_RETRY} dalam ${wait}ms`);
        await delay(wait);
        continue;
      }
      throw err;
    }
  }
  // Semua percobaan rate-limit habis tanpa berhasil
  throw new Error(`Gagal memanggil AI setelah ${MAX_RETRY} percobaan (rate limit).`);
}

// ==================== HELPER: TANGGAL SERVER (WIB) ====================
/**
 * LLM tidak tahu tanggal "sekarang" secara real-time — ia hanya menebak dari data training,
 * makanya pertanyaan seperti "kemarin" bisa dijawab dengan tanggal yang salah (mis. tahun training).
 * Fungsi ini mengambil tanggal aktual dari server (timezone Asia/Jakarta) untuk disuntikkan
 * ke system prompt, supaya AI menghitung "hari ini/kemarin/minggu ini/bulan ini" dari acuan yang benar.
 */
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
  }).format(now); // contoh: Selasa, 14 Juli 2026

  const time = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now); // contoh: 10.45

  // Hitung tanggal kemarin dengan aman berdasarkan isoDate (bukan objek Date lokal server)
  const [y, m, d] = isoDate.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d));
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayIso = yesterday.toISOString().slice(0, 10);

  return { isoDate, readable, time, yesterdayIso };
}

// ==================== CHAT WITH AI ====================
async function chatWithAI(userInput, context = "") {
  // ─── LANGKAH RAG: RETRIEVAL ───
  let retrievedContext = "";
  try {
    // 1. Buat embedding dari pertanyaan user
    const queryEmbedding = await createEmbedding(userInput);

    if (queryEmbedding) {
      // 2. Cari dokumen relevan di Supabase
      const { data: documents, error } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbedding,
        match_threshold: 0.75, // Tingkat kemiripan minimum
        match_count: 3         // Ambil 3 dokumen teratas
      });

      if (error) {
        console.error("❌ RAG search error:", error.message);
      } else if (documents && documents.length > 0) {
        console.log(`📚 RAG: Ditemukan ${documents.length} dokumen relevan.`);
        retrievedContext = "Berikut adalah beberapa konteks dari knowledge base yang mungkin relevan:\n\n" +
          documents.map(doc => `--- Dokumen: ${doc.title} ---\n${doc.content}`).join("\n\n");
      }
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

### Tugas Utama
1. Selalu gunakan data dari Supabase sebagai sumber informasi utama. Jangan pernah mengasumsikan atau menciptakan informasi.
2. Pahami intent pengguna terlebih dahulu — pengguna bisa bertanya secara bebas mengenai seluruh knowledge base, tidak hanya berdasarkan nomor tiket.
3. Tentukan data apa yang perlu diambil dari Supabase, lalu lakukan retrieval terhadap SELURUH data yang relevan (bukan hanya berdasarkan ticket_id).
4. Setelah data diperoleh, lakukan reasoning, agregasi, atau summarization untuk menghasilkan jawaban yang akurat dan informatif.
5. Jika data relevan tidak ditemukan di Supabase, jelaskan dengan sopan bahwa informasi tersebut tidak tersedia.

### Tools yang Tersedia
- \`get_ticket_detail\`: gunakan HANYA jika pengguna menyebutkan satu ticket_id spesifik.
- \`query_tickets\`: gunakan untuk pertanyaan umum/bebas yang TIDAK menyebutkan ticket_id — filter berdasarkan status, kategori, prioritas, assignee, kata kunci, atau rentang tanggal. Contoh: "apa tiket hari ini?", "berapa tiket yang masih open?", "ada masalah apa saja di server?", "siapa yang paling banyak mengerjakan tiket minggu ini?".
- \`update_ticket\` dan \`delete_ticket\`: gunakan hanya saat pengguna eksplisit meminta perubahan/penghapusan data pada ticket_id tertentu.
- Konteks RAG di bawah (jika ada) adalah sumber utama untuk pertanyaan seputar knowledge base, SOP, atau solusi teknis.

### Aturan Retrieval
Sesuaikan filter \`query_tickets\` dengan isi pertanyaan, contoh:
- "Apa tiket hari ini?" → filter tanggal hari ini.
- "Berapa tiket yang masih open?" → filter status Open.
- "Siapa yang paling banyak mengerjakan tiket minggu ini?" → ambil tiket minggu ini, lalu agregasikan berdasarkan assignee.
- "Ada masalah apa saja di server?" → filter keyword "server".
- "Apa saja incident bulan ini?" → filter kategori Incident + rentang tanggal bulan berjalan.
- "Ada issue penting?" → filter priority High/Critical dan status belum selesai.
- "Apa update terbaru?" → urutkan berdasarkan updated_at.

### Aturan Jawaban
- Jawaban harus selalu berdasarkan data hasil retrieval, jangan mengarang informasi.
- Untuk pertanyaan "berapa/jumlah tiket ...", gunakan field \`count\` dari hasil \`query_tickets\` (jumlah pasti dari database), BUKAN menghitung sendiri panjang daftar \`tickets\` yang dikembalikan (daftar itu dibatasi jumlahnya).
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
          const toolResult = await executeTool(toolCall);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
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

// Fungsi baru untuk mengindeks sebuah dokumen (bisa dipanggil dari skrip terpisah)
export async function indexDocument(title, content, source = 'manual') {
  console.log(`📚 Mengindeks dokumen: "${title}"`);
  const embedding = await createEmbedding(content);
  if (!embedding) return;
  const { error } = await supabase.from('knowledge_base').insert({ title, content, source, embedding });
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

function cleanJSON(text) {
  return text.replace(/```json/g, "").replace(/```/g, "").trim();
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
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