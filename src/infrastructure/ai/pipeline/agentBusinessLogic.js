// src/infrastructure/ai/pipeline/agentBusinessLogic.js
import { callOpenAIChatCompletion, AI_MODEL, cleanJSON } from "../aiClient.js";

const BUSINESS_RULES = `
1. Tiket dengan priority "emergency" seharusnya berstatus "Open" atau "In Progress", bukan "Done" tanpa action_needed yang jelas selesai dikerjakan.
2. Klaim status "Done" idealnya disertai action_needed yang sudah terselesaikan, bukan masih menyebut tindakan yang belum dikerjakan.
3. Tiket dengan status "Cancelled" seharusnya tidak lagi punya action_needed yang aktif/mendesak.
`;

/**
 * AGENT 3 — BUSINESS LOGIC CHECKER (LLM-based)
 * untuk:
 * - Menilai apakah data/hasil aksi sudah sesuai aturan bisnis ITSM.
 * - Menentukan apakah Main Model butuh data tambahan sebelum menjawab user.
 */
export async function runBusinessLogicChecker(toolName, args, rawResult, validationResult) {
  if (validationResult.isError) {
    return {
      agent: "business_logic",
      compliant: false,
      violations: [],
      needs_more_data: false,
      additional_data_needed: null,
      reason: "Data gagal diambil (error) — pemeriksaan business logic dilewati.",
    };
  }

  if (validationResult.isEmpty) {
    return {
      agent: "business_logic",
      compliant: true,
      violations: [],
      needs_more_data: false,
      additional_data_needed: null,
      reason: "Tidak ada data untuk dievaluasi terhadap aturan bisnis.",
    };
  }

  const trimmedData = JSON.stringify(rawResult).slice(0, 4000);

  const prompt = `Anda adalah Business Logic Checker untuk sistem ITSM. Berikut aturan bisnis yang berlaku:
${BUSINESS_RULES}

Tool yang dipanggil: "${toolName}", argumen: ${JSON.stringify(args)}
DATA HASIL QUERY:
${trimmedData}

Tugas:
1. Periksa apakah data/aksi ini sesuai aturan bisnis di atas.
2. Tentukan apakah Main Model kemungkinan butuh data tambahan sebelum menjawab user dengan baik (misal user tanya hal spesifik yang datanya belum lengkap di sini).

Balas HANYA JSON valid, tanpa penjelasan tambahan:
{
  "compliant": true atau false,
  "violations": ["daftar pelanggaran aturan bisnis singkat, array kosong jika tidak ada"],
  "needs_more_data": true atau false,
  "additional_data_needed": "deskripsi singkat data tambahan yang diperlukan, atau null jika tidak ada",
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
      agent: "business_logic",
      compliant: parsed.compliant !== false,
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      needs_more_data: !!parsed.needs_more_data,
      additional_data_needed: parsed.additional_data_needed || null,
      reason: parsed.reason || "",
    };
  } catch (err) {
    console.error("❌ Business Logic Agent error:", err.message);
    // Fail-safe: jangan blokir pipeline, tandai compliant=true supaya tidak menahan jawaban,
    // tapi reason mencatat bahwa pemeriksaan sebetulnya tidak sempat berjalan.
    return {
      agent: "business_logic",
      compliant: true,
      violations: [],
      needs_more_data: false,
      additional_data_needed: null,
      reason: "Pemeriksaan business logic gagal dijalankan karena kendala teknis — dilewati sebagai fail-safe.",
    };
  }
}