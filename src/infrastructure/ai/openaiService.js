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

// ==================== TOOLS / FUNCTION CALLING ====================

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

// ==================== CHAT WITH AI (DENGAN TOOL CALLING) ====================

export async function chatWithAI(text, context = "") {
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
        model: "gpt-4o-mini",           // atau gpt-4o jika mau lebih pintar
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 800,
      });

      const message = response.choices[0]?.message;

      // Jika AI ingin memanggil tool
      if (message.tool_calls && message.tool_calls.length > 0) {
        // Tambahkan respons AI ke messages
        messages.push(message);

        // Eksekusi setiap tool call
        for (const toolCall of message.tool_calls) {
          const toolResult = await executeTool(toolCall);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }

        // Panggil AI lagi agar memberikan respons akhir ke user
        continue;
      }

      // Jika tidak ada tool call, kembalikan respons biasa
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

// Export analyzeEmail tetap sama seperti sebelumnya (untuk WhatsApp)
export { analyzeEmail };   // pastikan fungsi analyzeEmail kamu tetap ada di file ini
// ==================== MAIN FUNCTION ====================

export async function analyzeEmail(email) {
  const fullText = `${email.subject} ${email.body}`.trim();
  
  // === STEP 1: Pre-filter Small Talk ===
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

  // Jika CRITICAL → langsung proses tanpa AI (fast path)
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

  // === STEP 2: Gunakan AI untuk analisis lebih dalam ===
  const prompt = `
Anda adalah AI ITSM yang cerdas dan teliti.

Tugas Anda:
- Analisis pesan dari WhatsApp Group
- Tentukan apakah pesan ini **perlu ditindaklanjuti** sebagai tiket ITSM atau hanya obrolan biasa
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
        temperature: 0.1,        // lebih rendah = lebih konsisten
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

  // Fallback
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