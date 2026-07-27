// src/infrastructure/ai/pipeline/agentBusinessLogic.js

import {
  callOpenAIChatCompletion,
  AI_MODEL,
  cleanJSON,
} from "../aiClient.js";

const BUSINESS_RULES = `
1. Data dengan ticket_state "confirmed" wajib memiliki confirmed_at dan tidak boleh memiliki rejected_at.
2. Data dengan ticket_state "pending_confirmation" wajib memiliki confirmed_at kosong dan rejected_at kosong.
3. Data dengan ticket_state "rejected" wajib memiliki rejected_at.
4. Jika confirmed_at dan rejected_at sama-sama terisi, data tidak konsisten.
5. sla_confirm_warned dan sla_confirm_alerted hanya relevan untuk kandidat pending_confirmation.
6. sla_warned, sla_alerted, sla_deadline_minutes, dan escalated_at terutama relevan untuk tiket confirmed.
7. Kandidat severity emergency atau high harus diprioritaskan untuk konfirmasi.
8. Jika sla_confirm_alerted=true dan kandidat masih pending, kandidat telah melewati alert SLA konfirmasi.
9. Jika escalated_at terisi, status idealnya Escalated atau tersedia penjelasan eskalasi.
10. Tiket emergency seharusnya tidak Done tanpa bukti penyelesaian yang jelas.
11. Tiket Done idealnya tidak mempunyai action_needed aktif atau mendesak.
12. Tiket Cancelled seharusnya tidak mempunyai action_needed aktif.
`;

export async function runBusinessLogicChecker(
  toolName,
  args,
  rawResult,
  validationResult
) {
  if (validationResult.isError) {
    return {
      agent: "business_logic",
      compliant: false,
      violations: [],
      needs_more_data: false,
      additional_data_needed: null,
      reason: "Data gagal diambil (error) - pemeriksaan business logic dilewati.",
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

  const trimmedData = JSON.stringify(rawResult).slice(0, 5000);

  const prompt = `Anda adalah Business Logic Checker untuk sistem ITSM.

ATURAN BISNIS:
${BUSINESS_RULES}

Tool: ${toolName}
Argumen: ${JSON.stringify(args)}

DATA HASIL QUERY:
${trimmedData}

Periksa konsistensi lifecycle, severity, SLA konfirmasi, SLA pekerjaan, dan eskalasi.
Balas HANYA JSON valid:
{
  "compliant": true,
  "violations": [],
  "needs_more_data": false,
  "additional_data_needed": null,
  "reason": "alasan singkat"
}`;

  try {
    const response = await callOpenAIChatCompletion({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "Anda hanya menjawab dengan format JSON valid.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 400,
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(cleanJSON(response.choices[0].message.content));

    return {
      agent: "business_logic",
      compliant: parsed.compliant !== false,
      violations: Array.isArray(parsed.violations)
        ? parsed.violations
        : [],
      needs_more_data: Boolean(parsed.needs_more_data),
      additional_data_needed: parsed.additional_data_needed || null,
      reason: parsed.reason || "",
    };
  } catch (err) {
    console.error("❌ Business Logic Agent error:", err.message);

    return {
      agent: "business_logic",
      compliant: true,
      violations: [],
      needs_more_data: false,
      additional_data_needed: null,
      reason:
        "Pemeriksaan business logic gagal dijalankan karena kendala teknis - dilewati sebagai fail-safe.",
    };
  }
}
