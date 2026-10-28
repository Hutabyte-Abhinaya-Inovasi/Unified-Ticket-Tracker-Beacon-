// src/infrastructure/ai/aiClient.js

import OpenAI from "openai";
import { env } from "../../config/env.js";

const configuredProvider = String(env.AI_PROVIDER || "").trim().toLowerCase();

if (configuredProvider && !["openai", "gemini"].includes(configuredProvider)) {
  throw new Error('AI_PROVIDER harus bernilai "openai" atau "gemini".');
}

export const AI_PROVIDER =
  configuredProvider || (env.GEMINI_API_KEY ? "gemini" : "openai");
const isGemini = AI_PROVIDER === "gemini";
const apiKey = isGemini ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error(
    `${isGemini ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} belum dikonfigurasi untuk AI_PROVIDER=${AI_PROVIDER}.`
  );
}

export const client = new OpenAI({
  apiKey,
  baseURL: isGemini ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined,
});

export const AI_MODEL = isGemini
  ? env.GEMINI_MODEL || "gemini-2.5-flash"
  : env.OPENAI_MODEL || "gpt-4o-mini";

console.log(`🤖 AI provider aktif: ${AI_PROVIDER} (${AI_MODEL})`);

const MAX_RETRY = 5;

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export function cleanJSON(text) {
  return (text || "").replace(/```json/g, "").replace(/```/g, "").trim();
}

// ==================== CALL OPENAI WITH RETRY ====================
export async function callOpenAIChatCompletion(options) {
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