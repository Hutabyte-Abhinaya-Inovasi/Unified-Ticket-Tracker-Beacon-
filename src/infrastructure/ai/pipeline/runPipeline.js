// src/infrastructure/ai/pipeline/runPipeline.js
import { runDataValidation } from "./agentDataValidation.js";
import { runDataAuditor } from "./agentDataAuditor.js";
import { runBusinessLogicChecker } from "./agentBusinessLogic.js";
import { buildFinalContext } from "./agentContextBuilder.js";

/**

 * @param {string} toolName - nama tool yang dipanggil (get_ticket_detail, query_tickets, dst)
 * @param {object} args - argumen yang dipakai saat memanggil tool
 * @param {object} rawResult - hasil mentah dari Supabase (sebelum divalidasi)
 * @returns {Promise<object>} finalContext siap dikirim sebagai content pesan role "tool"
 */
export async function runPipeline(toolName, args, rawResult) {
  const startedAt = Date.now();

  // Agent 1 — Data Validation (rule-based, selalu jalan duluan, murah & cepat)
  const validationResult = runDataValidation(toolName, args, rawResult);

  // Agent 2 & 3 — LLM-based, jalan paralel
  const [auditResult, businessResult] = await Promise.all([
    runDataAuditor(toolName, args, rawResult, validationResult),
    runBusinessLogicChecker(toolName, args, rawResult, validationResult),
  ]);

  // Agent 4 — Context Builder (rule-based, menyatukan semuanya)
  const finalContext = buildFinalContext(toolName, args, rawResult, validationResult, auditResult, businessResult);

  const durationMs = Date.now() - startedAt;
  console.log(
    `🧩 Pipeline [${toolName}] selesai dalam ${durationMs}ms — ` +
      `valid=${validationResult.valid} confidence=${auditResult.confidence_score} compliant=${businessResult.compliant}`
  );

  return { ...finalContext, pipeline_duration_ms: durationMs };
}