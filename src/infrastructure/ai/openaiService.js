// src/infrastructure/ai/openaiService.js

import OpenAI from "openai";
import { env } from "../../config/env.js";

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

// 🔥 CONFIG
const MAX_INPUT_LENGTH = 1500; // lebih hemat token
const MAX_RETRY = 3;

// 🔥 PRIORITY KEYWORDS (RULE BASED)
const PRIORITY_RULES = [
  { keyword: ["down", "server mati", "tidak bisa diakses"], priority: "CRITICAL" },
  { keyword: ["error", "failed", "gagal"], priority: "HIGH" },
  { keyword: ["lambat", "slow"], priority: "MEDIUM" },
];

// 🔥 CATEGORY RULES (BIAR HEMAT AI)
const CATEGORY_RULES = [
  { keyword: ["password", "login", "akses"], category: "Service Request Management" },
  { keyword: ["error", "bug", "failure"], category: "Incident Management" },
  { keyword: ["perubahan", "update"], category: "Change Management" },
  { keyword: ["berulang", "sering terjadi"], category: "Problem Management" },
];

// 🔥 LIMIT TEXT
function limitText(text, max = MAX_INPUT_LENGTH) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

// 🔥 CLEAN JSON
function cleanJSON(text) {
  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

// 🔥 DELAY
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// 🔥 RULE ENGINE (HEMAT AI)
function detectByRules(email) {
  const text = `${email.subject} ${email.body}`.toLowerCase();

  let priority = "LOW";
  let category = "Service Request Management";

  for (const rule of PRIORITY_RULES) {
    if (rule.keyword.some((k) => text.includes(k))) {
      priority = rule.priority;
      break;
    }
  }

  for (const rule of CATEGORY_RULES) {
    if (rule.keyword.some((k) => text.includes(k))) {
      category = rule.category;
      break;
    }
  }

  return { priority, category };
}

export async function analyzeEmail(email) {
  const safeBody = limitText(email.body);
  const safeSubject = limitText(email.subject, 200);

  
  const ruleResult = detectByRules(email);

  
  if (ruleResult.priority === "CRITICAL") {
    return {
      summary: safeSubject,
      category: ruleResult.category,
      priority: "CRITICAL",
      response: "Tim kami sedang menangani masalah ini secepat mungkin.",
    };
  }

  const prompt = `
Anda adalah AI ITSM.

Balas HANYA JSON VALID tanpa teks tambahan:

{
 "summary": "ringkasan singkat",
 "category": "Incident Management | Problem Management | Change Management | Service Request Management",
 "priority": "LOW | MEDIUM | HIGH | CRITICAL",
 "response": "balasan profesional"
}

EMAIL:
Subject: ${safeSubject}
Body:
${safeBody}
`;

  let attempt = 0;

  while (attempt < MAX_RETRY) {
    try {
      const response = await client.chat.completions.create({   // ← BUKAN .responses.create
  model: "gpt-4o-mini",                                   // ← ganti ke model yang valid
  messages: [
    { role: "system", content: "Anda adalah AI ITSM yang membantu klasifikasi tiket." },
    { role: "user", content: prompt }
  ],
  max_tokens: 300,
  temperature: 0.3,
});

// Ambil teks jawaban
let text = response.choices[0]?.message?.content || "";
text = cleanJSON(text);

      const parsed = JSON.parse(text);

      return {
        summary: parsed.summary || safeSubject,
        category: parsed.category || ruleResult.category,
        priority: parsed.priority || ruleResult.priority,
        response:
          parsed.response ||
          "Terima kasih, tim kami akan segera menindaklanjuti.",
      };

    } catch (err) {
      attempt++;

      // 🔥 RATE LIMIT
      if (err.status === 429 || err.code === "rate_limit_exceeded") {
        const wait = 2000 * attempt;
        console.warn(`⏳ Retry OpenAI ${attempt} dalam ${wait} ms`);
        await delay(wait);
        continue;
      }

      // 🔥 JSON ERROR
      if (err instanceof SyntaxError) {
        console.warn("⚠️ JSON tidak valid dari AI");
        break;
      }

      console.error("❌ OpenAI Error:", err.message);
      break;
    }
  }

  // 🔥 FALLBACK FINAL (NO AI)
  return {
    summary: safeSubject,
    category: ruleResult.category,
    priority: ruleResult.priority,
    response: "Terima kasih, laporan Anda sedang diproses oleh tim kami.",
  };
}

/**
 * 🔥 CHAT AI (VERSI STABIL)
 */
export async function chatWithAI(text, context = "") {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `Kamu adalah asisten ITSM yang membantu tim teknis. 
          Gunakan bahasa Indonesia yang sopan dan profesional.${context}` 
        },
        { role: "user", content: text }
      ],
      max_tokens: 400,
      temperature: 0.4,
    });

    return response.choices[0]?.message?.content?.trim() || "Tidak ada respon dari AI";
  } catch (err) {
    console.error("❌ Chat AI Error:", err.message);
    return "Maaf, AI sedang sibuk. Coba lagi nanti.";
  }
}