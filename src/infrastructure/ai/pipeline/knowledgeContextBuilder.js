// src/infrastructure/ai/pipeline/knowledgeContextBuilder.js

export function buildKnowledgeContext(toolName, args, rawResult, validationResult) {
  let guidance;

  if (validationResult.isError) {
    guidance =
      "Outline gagal diakses. Jelaskan kendala teknis kepada pengguna dan jangan membuat SOP sendiri.";
  } else if (validationResult.isEmpty) {
    guidance =
      "Pencarian Outline berhasil tetapi tidak menemukan dokumen relevan. Sampaikan apa adanya dan jangan mengarang.";
  } else if (!validationResult.valid) {
    guidance =
      "Sebagian hasil Outline tidak lengkap. Gunakan hanya dokumen yang memiliki title dan content yang jelas.";
  } else {
    guidance =
      "Gunakan dokumen Outline berikut sebagai sumber knowledge. Sertakan judul dan URL sumber jika tersedia.";
  }

  return {
    tool: toolName,
    arguments: args,
    knowledge: Array.isArray(rawResult?.documents) ? rawResult.documents : [],
    source: "outline",
    pipeline_meta: {
      validation: {
        valid: validationResult.valid,
        is_empty: validationResult.isEmpty,
        is_error: validationResult.isError,
        issues: validationResult.issues,
        document_count: validationResult.documentCount,
        partial_failures: validationResult.partialFailures,
      },
    },
    guidance_for_main_model: guidance,
  };
}
