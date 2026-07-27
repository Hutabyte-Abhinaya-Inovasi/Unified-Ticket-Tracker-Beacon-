// src/infrastructure/ai/pipeline/agentKnowledgeValidation.js

export function runKnowledgeValidation(toolName, args, rawResult) {
  const issues = [];
  let isError = false;
  let isEmpty = false;

  if (toolName !== "search_outline_knowledge") {
    return {
      agent: "knowledge_validation",
      valid: false,
      isEmpty: false,
      isError: true,
      documentCount: 0,
      issues: [`Tool knowledge tidak dikenal: ${toolName}`],
    };
  }

  if (!rawResult || typeof rawResult !== "object") {
    return {
      agent: "knowledge_validation",
      valid: false,
      isEmpty: false,
      isError: true,
      documentCount: 0,
      issues: ["Hasil retrieval Outline kosong atau bukan object."],
    };
  }

  if (rawResult.error) {
    isError = true;
    issues.push(`Outline mengembalikan error: ${rawResult.error}`);
  }

  if (!Array.isArray(rawResult.documents)) {
    issues.push("Field documents pada hasil Outline bukan array.");
  }

  const documents = Array.isArray(rawResult.documents) ? rawResult.documents : [];
  if (!isError && documents.length === 0) {
    isEmpty = true;
  }

  documents.forEach((document, index) => {
    if (!document?.title) {
      issues.push(`Dokumen ke-${index + 1} tidak memiliki title.`);
    }
    if (!document?.content) {
      issues.push(`Dokumen ke-${index + 1} tidak memiliki content.`);
    }
  });

  return {
    agent: "knowledge_validation",
    valid: !isError && issues.length === 0,
    isEmpty,
    isError,
    documentCount: documents.length,
    issues,
    partialFailures: Array.isArray(rawResult.partial_failures)
      ? rawResult.partial_failures
      : [],
    query: args?.query || rawResult.query || null,
  };
}
