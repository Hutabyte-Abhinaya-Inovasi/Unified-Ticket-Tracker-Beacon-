// src/infrastructure/ai/openaiService.js
import OpenAI from "openai";
import { env } from "../../config/env.js";
import { 
  getTicketById, 
  updateTicket, 
  deleteTicket 
} from "../../database/supabase.js";

const isGemini = !!env.GEMINI_API_KEY;

const client = new OpenAI({
  apiKey: env.GEMINI_API_KEY || env.OPENAI_API_KEY,
  baseURL: isGemini ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined,
});

const AI_MODEL = isGemini ? "gemini-2.5-flash" : "gpt-4o-mini";

const MAX_RETRY = 5;

// ==================== TOOLS DEFINITION ====================
const tools = [
  {
    type: "function",
    function: {
      name: "get_ticket_detail",
      description: "Menampilkan detail lengkap sebuah ticket berdasarkan ticket_id",
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

// ==================== EXECUTE TOOL ====================
async function executeTool(toolCall) {
  const functionName = toolCall.function.name;
  const args = JSON.parse(toolCall.function.arguments);

  try {
    switch (functionName) {
      case "get_ticket_detail":
        return await getTicketById(args.ticket_id);

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
}

// ==================== CHAT WITH AI ====================
async function chatWithAI(text, context = "") {
  let messages = [
    {
      role: "system",
      content: `Kamu adalah asisten ITSM yang cerdas, sopan, dan membantu tim teknis.
Gunakan bahasa Indonesia yang profesional.
Kamu memiliki kemampuan untuk melihat, mengupdate, dan menghapus ticket menggunakan tools yang tersedia.
Jika user meminta update/hapus/tampilkan ticket, gunakan tool yang sesuai.`
    },
    { role: "user", content: text + context }
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

    let text = response.choices[0]?.message?.content || "";
    text = cleanJSON(text);
    
    const parsed = JSON.parse(text);

    return {
      shouldProcess: parsed.isRelevant !== false,
      isRelevant: parsed.isRelevant !== false,
      confidence_score: parsed.confidence_score !== undefined ? Number(parsed.confidence_score) : 100,
      original_message: parsed.original_message || email.body,
      subject: email.subject,
      category: parsed.category || ruleResult.category,
      priority: parsed.priority || ruleResult.priority,
      response: parsed.response || null,
      reason: parsed.isRelevant === false ? "ai_filtered" : "processed",
    };

  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn("❌ JSON parse error dari AI");
    } else {
      console.error("OpenAI Error:", err.message);
    }
  }

  return {
    shouldProcess: true,
    isRelevant: true,
    confidence_score: 100,
    original_message: email.body,
    subject: email.subject,
    category: ruleResult.category,
    priority: ruleResult.priority,
    response: "Terima kasih, laporan Anda sedang diproses oleh tim kami.",
  };
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
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
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
    const validSeverities = ["emergency", "high", "medium", "low", "others"];
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
  
  const IRRELEVANT_PATTERNS = [
    /^hai+$/i, /^halo+$/i, /^hi+$/i, /^hello+$/i,
    /^terima kasih$/i, /^thanks$/i, /^thank you$/i,
    /^sama-sama$/i, /^ok$/i, /^oke$/i, /^sip$/i, /^mantap$/i,
    /^sudah$/i, /^done$/i, /^selesai$/i,
    /^apa kabar?$/i, /^kabar$/i,
    /^(ya|iya|betul|benar)$/i,
  ];

  for (const pattern of IRRELEVANT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  if (trimmed.length < 15) {
    const technicalWords = /(server|error|login|password|down|lambat|issue|bug|ticket|tiket)/i;
    if (!technicalWords.test(trimmed)) return true;
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
  chatWithAI, 
  analyzeEmail,
  checkMessageRelevance,
  routeMessageToActiveTickets,
  detectStatusChangeFromReply,
  extractTicketFields,
  isSmallTalk
};