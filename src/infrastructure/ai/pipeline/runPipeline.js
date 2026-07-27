// src/infrastructure/ai/pipeline/runPipeline.js

import {
  runDataValidation,
} from "./agentDataValidation.js";

import {
  runDataAuditor,
} from "./agentDataAuditor.js";

import {
  runBusinessLogicChecker,
} from "./agentBusinessLogic.js";

import {
  buildFinalContext,
} from "./agentContextBuilder.js";

import {
  runKnowledgeValidation,
} from "./agentKnowledgeValidation.js";

import {
  buildKnowledgeContext,
} from "./knowledgeContextBuilder.js";

const TICKET_TOOLS = new Set([
  "get_ticket_detail",
  "query_tickets",
]);

const KNOWLEDGE_TOOLS = new Set([
  "search_outline_knowledge",
]);

/**
 * Menjalankan pipeline sesuai jenis tool.
 *
 * Ticket tools:
 * Data Validation
 * → Data Auditor
 * → Business Logic Checker
 * → Ticket Context Builder
 *
 * Knowledge tools:
 * Knowledge Validation
 * → Knowledge Context Builder
 */
export async function runPipeline(
  toolName,
  args,
  rawResult
) {
  const startedAt = Date.now();

  // ==================== KNOWLEDGE PIPELINE ====================
  if (KNOWLEDGE_TOOLS.has(toolName)) {
    const validationResult =
      runKnowledgeValidation(
        toolName,
        args,
        rawResult
      );

    const finalContext =
      buildKnowledgeContext(
        toolName,
        args,
        rawResult,
        validationResult
      );

    const durationMs =
      Date.now() - startedAt;

    console.log(
      `📚 Knowledge Pipeline [${toolName}] selesai dalam ${durationMs}ms — ` +
      `valid=${validationResult.valid} ` +
      `empty=${validationResult.isEmpty} ` +
      `documents=${validationResult.documentCount}`
    );

    return {
      ...finalContext,
      pipeline_duration_ms: durationMs,
    };
  }

  // ==================== TICKET PIPELINE ====================
  if (TICKET_TOOLS.has(toolName)) {
    const validationResult =
      runDataValidation(
        toolName,
        args,
        rawResult
      );

    const [
      auditResult,
      businessResult,
    ] = await Promise.all([
      runDataAuditor(
        toolName,
        args,
        rawResult,
        validationResult
      ),

      runBusinessLogicChecker(
        toolName,
        args,
        rawResult,
        validationResult
      ),
    ]);

    const finalContext =
      buildFinalContext(
        toolName,
        args,
        rawResult,
        validationResult,
        auditResult,
        businessResult
      );

    const durationMs =
      Date.now() - startedAt;

    console.log(
      `🧩 Ticket Pipeline [${toolName}] selesai dalam ${durationMs}ms — ` +
      `valid=${validationResult.valid} ` +
      `confidence=${auditResult.confidence_score} ` +
      `compliant=${businessResult.compliant}`
    );

    return {
      ...finalContext,
      pipeline_duration_ms: durationMs,
    };
  }

  // ==================== UNKNOWN TOOL ====================
  const durationMs =
    Date.now() - startedAt;

  return {
    tool: toolName,
    arguments: args,
    data: rawResult,

    pipeline_meta: {
      pipeline_type: "unknown",
      validation: {
        valid: false,
        is_empty: false,
        is_error: true,
        issues: [
          `Tool "${toolName}" belum terdaftar pada pipeline`,
        ],
      },
    },

    guidance_for_main_model:
      `Tool "${toolName}" belum mempunyai pipeline validasi. ` +
      "Jangan menggunakan hasilnya sebagai fakta.",

    pipeline_duration_ms: durationMs,
  };
}