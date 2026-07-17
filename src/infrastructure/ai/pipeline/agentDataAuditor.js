// src/infrastructure/ai/pipeline/agentDataAuditor.js
import { callOpenAIChatCompletion, AI_MODEL, cleanJSON } from "../aiClient.js";

/**
 * AGENT 2 — DATA AUDITOR (LLM-based)
 *
 * Tanggung jawab:
 * - Memverifikasi konsistensi data (mendeteksi informasi yang saling bertentangan).
 * - Memberikan confidence_score (0-100) seberapa layak data ini dipakai Main Model.
 */
export async function runDataAuditor(toolName, args, rawResult, validationResult) {
  if (validationResult.isError) {
    return {
      agent: "data_auditor",
      consistent: false,
      confidence_score: 0,
      inconsistencies: [],
      reason: "Data gagal diambil (error) — audit dilewati.",
    };
  }

  if (validationResult.isEmpty) {
    return {
      agent: "data_auditor",
      consistent: true,
      confidence_score: 100,
      inconsistencies: [],
      reason: "Data kosong secara sah (tidak ada baris yang cocok filter) — tidak ada yang perlu diaudit.",
    };
  }

  const trimmedData = JSON.stringify(rawResult).slice(0, 4000);

  const prompt = `Anda adalah Data Auditor untuk sistem ITSM.
Periksa hasil query berikut, yang diambil dari database, untuk permintaan pengguna terhadap tool "${toolName}" dengan argumen: ${JSON.stringify(args)}.

DATA:
${trimmedData}

Tugas Anda:
1. Periksa apakah ada data yang saling bertentangan/tidak konsisten (contoh: status "Done" tapi action_needed masih menyebutkan tindakan mendesak; priority "emergency" tapi terkesan sudah lama tidak disentuh tanpa alasan jelas).
2. Berikan confidence_score (0-100) seberapa layak data ini langsung dipakai untuk menjawab pengguna.

Balas HANYA JSON valid, tanpa penjelasan tambahan:
{
  "consistent": true atau false,
  "confidence_score": 0-100,
  "inconsistencies": ["daftar ketidaksesuaian singkat, array kosong jika tidak ada"],
  "reason": "alasan singkat dalam bahasa Indonesia"
}`;

  try {
    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "Anda hanya menjawab dengan format JSON valid." },
        { role: "user", content: prompt },
      ],
      max_tokens: 300,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(cleanJSON(response.choices[0].message.content));

    return {
      agent: "data_auditor",
      consistent: parsed.consistent !== false,
      confidence_score: Number.isFinite(Number(parsed.confidence_score)) ? Number(parsed.confidence_score) : 50,
      inconsistencies: Array.isArray(parsed.inconsistencies) ? parsed.inconsistencies : [],
      reason: parsed.reason || "",
    };
  } catch (err) {
    console.error("❌ Data Auditor Agent error:", err.message);
    // Fail-safe: jangan blokir pipeline kalau LLM gagal, tapi turunkan confidence
    // supaya Main Model tetap menjawab dengan hati-hati, bukan menganggap data 100% valid.
    return {
      agent: "data_auditor",
      consistent: true,
      confidence_score: 50,
      inconsistencies: [],
      reason: "Audit gagal dijalankan karena kendala teknis — confidence diturunkan sebagai kehati-hatian.",
    };
  }
}