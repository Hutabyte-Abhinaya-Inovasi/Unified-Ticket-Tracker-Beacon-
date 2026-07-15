// src/infrastructure/ai/huggingfaceService.js

import { HfInference } from "@huggingface/inference";
import { env } from "../../config/env.js";

let hf;

/**
 * Menginisialisasi instance Hugging Face Inference.
 * @returns {HfInference|null} Instance HfInference atau null jika token tidak ada.
 */
function getHfInstance() {
  if (hf) return hf;
  if (!env.HF_TOKEN) {
    console.warn("⚠️  HF_TOKEN tidak diset di .env. Fitur embedding Hugging Face dinonaktifkan.");
    return null;
  }
  hf = new HfInference(env.HF_TOKEN);
  return hf;
}

/**
 * Membuat embedding dari sebuah teks menggunakan model sentence-transformers.
 * @param {string} text - Teks yang akan di-embed.
 * @returns {Promise<number[]|null>} Array of numbers (vector) atau null jika gagal.
 */
export async function createEmbedding(text) {
  const inference = getHfInstance();
  if (!inference || !text || typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  try {
    const model = "sentence-transformers/all-MiniLM-L6-v2";
    const response = await inference.featureExtraction({
      model: model,
      inputs: text.trim(),
    });

    // Pastikan respons adalah array dan bukan array multidimensi
    if (Array.isArray(response) && response.length > 0) {
      return Array.isArray(response[0]) ? response[0] : response;
    }
    return null;

  } catch (err) {
    console.error("❌ Gagal membuat embedding dari Hugging Face:", err.message);
    return null;
  }
}