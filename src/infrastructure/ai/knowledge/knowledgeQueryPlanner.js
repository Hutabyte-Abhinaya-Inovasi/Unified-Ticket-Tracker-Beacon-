// src/infrastructure/ai/knowledge/knowledgeQueryPlanner.js
import {
  AI_MODEL,
  callOpenAIChatCompletion,
  cleanJSON,
} from "../aiClient.js";

const MAX_QUERY_VARIANTS = 6;
const MAX_TITLE_CANDIDATES = 20;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_/\\|]+/g, " ")
    .replace(/[–—-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s.:+#()]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values, maximum = MAX_QUERY_VARIANTS) {
  const result = [];
  const seen = new Set();

  for (const value of values || []) {
    const normalized = normalizeText(value);
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(normalized);

    if (result.length >= maximum) break;
  }

  return result;
}

function safeParseJSON(value) {
  try {
    return JSON.parse(cleanJSON(value || "{}"));
  } catch {
    return {};
  }
}

/**
 * LLM Query Planner:
 * - membaca query, subject, description, project, dan konteks sebelumnya;
 * - memperbaiki typo/kata tergabung;
 * - membuat query Indonesia + Inggris;
 * - membuat title hints yang mendekati judul dokumen Outline.
 *
 * Fungsi ini fail-safe. Jika LLM gagal, caller tetap dapat memakai
 * deterministic search variants.
 */
export async function planKnowledgeSearch({
  query = "",
  subject = "",
  description = "",
  project = "",
  previousTopic = "",
} = {}) {
  const input = {
    query: normalizeText(query),
    subject: normalizeText(subject),
    description: normalizeText(description),
    project: normalizeText(project),
    previous_topic: normalizeText(previousTopic),
  };

  const response = await callOpenAIChatCompletion({
    model: AI_MODEL,
    temperature: 0,
    max_tokens: 600,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Anda adalah Query Planner untuk pencarian knowledge base teknis di Outline.
Tugas Anda BUKAN menjawab pertanyaan. Tugas Anda hanya membuat rencana pencarian.

Knowledge base dapat berbahasa Inggris, sementara pertanyaan dapat berbahasa Indonesia,
Inggris, campuran, memiliki typo, kata tergabung, singkatan, atau hanya menyebut sebagian judul.

Aturan:
1. Baca subject, description, project, pertanyaan, dan previous_topic secara bersamaan.
2. Perbaiki typo dan kata yang terlihat tergabung.
3. Pertahankan nama produk, sistem, project, report, command, field, dan singkatan teknis.
4. Buat query pencarian ringkas dalam bahasa pengguna.
5. Buat query pencarian bahasa Inggris yang natural.
6. Buat kemungkinan judul dokumen teknis dalam bahasa Inggris.
7. Jika project diketahui, gabungkan project dengan nama report/prosedur.
8. Jangan mengarang langkah penyelesaian atau isi dokumen.
9. Maksimal enam search_queries dan lima title_hints.
10. Jawab hanya dengan JSON valid.
        `.trim(),
      },
      {
        role: "user",
        content: `
INPUT:
${JSON.stringify(input, null, 2)}

Kembalikan JSON:
{
  "detected_language": "id | en | mixed | unknown",
  "intent": "knowledge_search | procedure | troubleshooting | report | other",
  "technical_entities": ["string"],
  "search_queries": ["string"],
  "title_hints": ["string"],
  "reason": "alasan singkat"
}
        `.trim(),
      },
    ],
  });

  const parsed = safeParseJSON(response.choices?.[0]?.message?.content);

  return {
    detected_language: parsed.detected_language || "unknown",
    intent: parsed.intent || "knowledge_search",
    technical_entities: uniqueStrings(parsed.technical_entities, 10),
    search_queries: uniqueStrings(parsed.search_queries, MAX_QUERY_VARIANTS),
    title_hints: uniqueStrings(parsed.title_hints, 5),
    reason: String(parsed.reason || "").trim(),
  };
}

/**
 * Rerank judul dokumen menggunakan LLM.
 * Hanya menerima katalog ID + title, sehingga LLM tidak dapat mengarang isi dokumen.
 */
export async function rerankKnowledgeTitles({
  query = "",
  subject = "",
  description = "",
  project = "",
  previousTopic = "",
  candidates = [],
  limit = 3,
} = {}) {
  const safeCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item?.id && item?.title)
    .slice(0, MAX_TITLE_CANDIDATES)
    .map((item) => ({
      id: String(item.id),
      title: String(item.title),
    }));

  if (safeCandidates.length === 0) {
    return { selected_ids: [], reason: "Tidak ada kandidat judul." };
  }

  const response = await callOpenAIChatCompletion({
    model: AI_MODEL,
    temperature: 0,
    max_tokens: 400,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Anda adalah semantic title reranker untuk knowledge base teknis.
Pilih hanya dokumen yang judulnya paling relevan terhadap kebutuhan pengguna.

Aturan:
1. Pertanyaan Indonesia boleh dicocokkan dengan judul Inggris.
2. Judul parsial boleh cocok dengan judul yang lebih lengkap.
3. Perhatikan project, nama report, sistem, fitur, dan singkatan teknis.
4. Jangan memilih hanya karena ada kata umum seperti issue, problem, report, atau procedure.
5. Hanya gunakan ID yang tersedia pada daftar kandidat.
6. Jika tidak ada judul yang relevan, selected_ids harus kosong.
7. Jawab hanya JSON valid.
        `.trim(),
      },
      {
        role: "user",
        content: `
KEBUTUHAN:
${JSON.stringify(
  {
    query: normalizeText(query),
    subject: normalizeText(subject),
    description: normalizeText(description),
    project: normalizeText(project),
    previous_topic: normalizeText(previousTopic),
  },
  null,
  2
)}

KANDIDAT JUDUL:
${JSON.stringify(safeCandidates, null, 2)}

Pilih maksimal ${Math.min(Math.max(Number(limit) || 3, 1), 5)} dokumen.

Kembalikan JSON:
{
  "selected_ids": ["id"],
  "reason": "alasan singkat"
}
        `.trim(),
      },
    ],
  });

  const parsed = safeParseJSON(response.choices?.[0]?.message?.content);
  const allowedIds = new Set(safeCandidates.map((item) => item.id));

  const selectedIds = Array.isArray(parsed.selected_ids)
    ? parsed.selected_ids
        .map(String)
        .filter((id) => allowedIds.has(id))
        .slice(0, Math.min(Math.max(Number(limit) || 3, 1), 5))
    : [];

  return {
    selected_ids: selectedIds,
    reason: String(parsed.reason || "").trim(),
  };
}
