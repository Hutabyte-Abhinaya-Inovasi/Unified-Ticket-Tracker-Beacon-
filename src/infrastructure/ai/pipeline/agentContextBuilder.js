// src/infrastructure/ai/pipeline/agentContextBuilder.js
/**
 * AGENT 4 — CONTEXT BUILDER (rule-based, TIDAK memanggil AI)
 *
 * Tugas:
 * - Menggabungkan data mentah + hasil Agent 1 (Data Validation), Agent 2 (Data Auditor),
 *   dan Agent 3 (Business Logic Checker) menjadi satu konteks terstruktur.
 */
export function buildFinalContext(toolName, args, rawResult, validationResult, auditResult, businessResult) {
  const pipelineMeta = {
    validation: {
      valid: validationResult.valid,
      is_empty: validationResult.isEmpty,
      is_error: validationResult.isError,
      issues: validationResult.issues,
    },
    audit: {
      consistent: auditResult.consistent,
      confidence_score: auditResult.confidence_score,
      inconsistencies: auditResult.inconsistencies,
    },
    business_logic: {
      compliant: businessResult.compliant,
      violations: businessResult.violations,
      needs_more_data: businessResult.needs_more_data,
      additional_data_needed: businessResult.additional_data_needed,
    },
  };

  let guidance;
  if (validationResult.isError) {
    guidance =
      "PERINGATAN: data gagal diambil dari database (lihat validation.issues). " +
      "Jelaskan ke user bahwa terjadi kendala teknis saat mengambil data, JANGAN mengarang jawaban.";
  } else if (validationResult.isEmpty) {
    guidance = "Data kosong secara sah — tidak ada baris yang cocok dengan filter yang dipakai. Sampaikan apa adanya ke user.";
  } else if (auditResult.confidence_score < 50) {
    guidance =
      `PERINGATAN: confidence_score audit rendah (${auditResult.confidence_score}/100). ` +
      "Sampaikan jawaban dengan hati-hati, sebutkan ada ketidakpastian pada data, jangan disampaikan sebagai fakta 100% pasti.";
  } else if (businessResult.violations.length > 0) {
    guidance =
      `PERHATIAN: ditemukan potensi pelanggaran aturan bisnis: ${businessResult.violations.join("; ")}. ` +
      "Pertimbangkan menyampaikan catatan ini ke user, terutama jika relevan dengan pertanyaannya.";
  } else if (businessResult.needs_more_data) {
    guidance =
      `Business Logic Checker menandai kemungkinan perlu data tambahan: ${businessResult.additional_data_needed || "(tidak dijelaskan detail)"}. ` +
      "Pertimbangkan memanggil tool lain (mis. get_ticket_detail untuk satu tiket spesifik) sebelum menjawab final ke user.";
  } else {
    guidance = "Data sudah tervalidasi, konsisten, dan sesuai aturan bisnis. Aman digunakan langsung untuk menjawab user.";
  }

  return {
    tool: toolName,
    arguments: args,
    data: rawResult,
    pipeline_meta: pipelineMeta,
    guidance_for_main_model: guidance,
  };
}