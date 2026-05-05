// src/infrastructure/ai/openaiService.js
import OpenAI from "openai";
import { env } from "../../config/env.js";
import { 
  getTicketById, 
  updateTicket, 
  deleteTicket 
} from "../../database/supabase.js";

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

const MAX_RETRY = 3;

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
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
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
- Analisis pesan dari WhatsApp Group
- Tentukan apakah pesan ini perlu ditindaklanjuti sebagai tiket ITSM atau hanya obrolan biasa
- Jika tidak relevan, set "isRelevant": false

Balas HANYA dengan JSON valid ini, tanpa penjelasan tambahan:

{
  "isRelevant": true atau false,
  "original_message": "salinan pesan asli dari user (jangan diringkas)",
  "category": "Incident Management | Problem Management | Change Management | Service Request Management",
  "priority": "LOW | MEDIUM | HIGH | CRITICAL",
  "response": "balasan profesional yang sopan (kosongkan jika isRelevant = false)"
}

EMAIL:
Subject: ${safeSubject}
Body:
${safeBody}
`;

  let attempt = 0;
  while (attempt < MAX_RETRY) {
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
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
        original_message: parsed.original_message || email.body,
        subject: email.subject,
        category: parsed.category || ruleResult.category,
        priority: parsed.priority || ruleResult.priority,
        response: parsed.response || null,
        reason: parsed.isRelevant === false ? "ai_filtered" : "processed",
      };

    } catch (err) {
      attempt++;
      if (err.status === 429 || err.code === "rate_limit_exceeded") {
        const wait = 2000 * attempt;
        console.warn(`⏳ Rate Limit - Retry ${attempt} dalam ${wait}ms`);
        await delay(wait);
        continue;
      }
      if (err instanceof SyntaxError) {
        console.warn("❌ JSON parse error dari AI");
        break;
      }
      console.error("OpenAI Error:", err.message);
      break;
    }
  }

  return {
    shouldProcess: true,
    isRelevant: true,
    original_message: email.body,
    subject: email.subject,
    category: ruleResult.category,
    priority: ruleResult.priority,
    response: "Terima kasih, laporan Anda sedang diproses oleh tim kami.",
  };
}

function isSmallTalk(text) {
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
  let priority = "LOW";
  let category = "Service Request Management";

  const PRIORITY_RULES = [
    { keyword: ["down", "server mati", "tidak bisa diakses", "mati total", "offline"], priority: "CRITICAL" },
    { keyword: ["error", "failed", "gagal", "tidak bisa", "crash"], priority: "HIGH" },
    { keyword: ["lambat", "slow", "lemot", "delay"], priority: "MEDIUM" },
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

  return { priority, category };
}

export { 
  chatWithAI, 
  analyzeEmail 
};