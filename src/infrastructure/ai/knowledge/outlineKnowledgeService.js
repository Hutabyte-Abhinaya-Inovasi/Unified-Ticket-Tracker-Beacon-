// src/infrastructure/ai/knowledge/outlineKnowledgeService.js
import { env } from "../../../config/env.js";

import {
  buildOutlineDocumentUrl,
  getOutlineDocument,
  getOutlineKnowledgeScope,
  listOutlineDocuments,
  searchOutlineDocuments,
} from "../../outline/outlineClient.js";

import {
  planKnowledgeSearch,
  rerankKnowledgeTitles,
} from "./knowledgeQueryPlanner.js";

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;
const MAX_SEARCH_VARIANTS = 8;

const DEFAULT_MAX_DOCUMENT_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 30_000;
const DEFAULT_CATALOG_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CATALOG_DOCUMENTS = 500;

const STOP_WORDS = new Set([
  "a",
  "ada",
  "adalah",
  "agar",
  "akan",
  "apa",
  "bagaimana",
  "bantu",
  "berhubungan",
  "berkaitan",
  "buat",
  "cari",
  "cara",
  "coba",
  "dalam",
  "dan",
  "dari",
  "dengan",
  "di",
  "gimana",
  "how",
  "in",
  "ini",
  "is",
  "issue",
  "it",
  "itu",
  "jelaskan",
  "ke",
  "masalah",
  "mengenai",
  "mohon",
  "of",
  "on",
  "pada",
  "penanganan",
  "penyelesaian",
  "please",
  "problem",
  "related",
  "terhadap",
  "terkait",
  "tentang",
  "the",
  "to",
  "tolong",
  "untuk",
  "what",
  "yang",
]);

const catalogCache = {
  collectionId: null,
  expiresAt: 0,
  documents: [],
};

function readNumber(name, fallback) {
  const value = Number(env?.[name] ?? process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.documents)) return value.documents;
  return [];
}

function extractSearchDocument(item = {}) {
  return item.document || item.data?.document || item.data || item;
}

function extractDetailDocument(response = {}) {
  return response?.data?.document || response?.data || response?.document || response;
}

function cleanDocumentText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\blaporanmo\b/gi, "laporan mo")
    .replace(/\bsinglemediation\b/gi, "single mediation")
    .replace(/\breformatsummary\b/gi, "reformat summary")
    .replace(/[_/\\|]+/g, " ")
    .replace(/[–—-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s.:+#()]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value, { removeStopWords = true } = {}) {
  return normalizeKey(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !removeStopWords || !STOP_WORDS.has(token));
}

function uniqueStrings(values, maximum = MAX_SEARCH_VARIANTS) {
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

function normalizeRetrievalInput(input, options = {}) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const subject =
      input.subject ||
      input.ticket_subject ||
      input.title ||
      options.subject ||
      "";

    const description =
      input.description ||
      input.ticket_description ||
      input.body ||
      input.summary ||
      input.details ||
      options.description ||
      "";

    const project =
      input.project ||
      input.project_name ||
      input.system ||
      options.project ||
      "";

    const previousTopic =
      input.previous_topic ||
      input.previousTopic ||
      input.last_document_title ||
      options.previousTopic ||
      "";

    const query =
      input.query ||
      [project, subject, description].filter(Boolean).join(" ");

    return {
      query: normalizeText(query),
      subject: normalizeText(subject),
      description: normalizeText(description),
      project: normalizeText(project),
      previousTopic: normalizeText(previousTopic),
      limit: input.limit ?? options.limit ?? DEFAULT_LIMIT,
      requestedCollectionId:
        input.collectionId ||
        input.collection_id ||
        options.collectionId ||
        null,
    };
  }

  return {
    query: normalizeText(input),
    subject: normalizeText(options.subject),
    description: normalizeText(options.description),
    project: normalizeText(options.project),
    previousTopic: normalizeText(options.previousTopic),
    limit: options.limit ?? DEFAULT_LIMIT,
    requestedCollectionId: options.collectionId || null,
  };
}

function buildDeterministicQueries({
  query,
  subject,
  description,
  project,
  previousTopic,
}) {
  const combined = [project, subject, description, query, previousTopic]
    .filter(Boolean)
    .join(" ");

  const importantTerms = tokenize(combined).join(" ");

  const technicalTerms = tokenize(combined, { removeStopWords: false })
    .filter(
      (token) =>
        /^[a-z0-9]{2,}$/i.test(token) &&
        (!STOP_WORDS.has(token) || /^[A-Z0-9]{2,}$/.test(token))
    )
    .join(" ");

  return uniqueStrings([
    [project, previousTopic].filter(Boolean).join(" "),
    [project, subject].filter(Boolean).join(" "),
    [project, description].filter(Boolean).join(" "),
    [project, query].filter(Boolean).join(" "),
    previousTopic,
    subject,
    description,
    query,
    importantTerms,
    technicalTerms,
  ]);
}

function titleSimilarityScore(title, queryVariants) {
  const titleKey = normalizeKey(title);
  if (!titleKey) return 0;

  const titleTokens = new Set(tokenize(title));
  let bestScore = 0;

  for (const variant of queryVariants) {
    const queryKey = normalizeKey(variant);
    if (!queryKey) continue;

    if (titleKey === queryKey) {
      bestScore = Math.max(bestScore, 2_000);
      continue;
    }

    if (titleKey.includes(queryKey)) {
      bestScore = Math.max(bestScore, 1_500 + Math.min(queryKey.length, 300));
    }

    if (queryKey.includes(titleKey)) {
      bestScore = Math.max(bestScore, 1_200 + Math.min(titleKey.length, 300));
    }

    const queryTokens = tokenize(variant);
    if (queryTokens.length === 0) continue;

    const matchedTokens = queryTokens.filter((token) => titleTokens.has(token));
    const coverage = matchedTokens.length / queryTokens.length;
    const titleCoverage =
      titleTokens.size > 0 ? matchedTokens.length / titleTokens.size : 0;

    const acronymBonus = matchedTokens.filter((token) => token.length <= 4).length * 40;
    const score = Math.round(coverage * 700 + titleCoverage * 500 + acronymBonus);
    bestScore = Math.max(bestScore, score);
  }

  return bestScore;
}

function mergeCandidate(candidateMap, document, {
  score = 0,
  matchedQuery = null,
  retrievalSource = "unknown",
} = {}) {
  const key = document?.id || document?.urlId || document?.url;
  if (!key) return;

  const existing = candidateMap.get(key);

  if (existing) {
    existing._retrieval_score += Number(score) || 0;

    if (matchedQuery && !existing._matched_queries.includes(matchedQuery)) {
      existing._matched_queries.push(matchedQuery);
    }

    if (!existing._retrieval_sources.includes(retrievalSource)) {
      existing._retrieval_sources.push(retrievalSource);
    }

    return;
  }

  candidateMap.set(key, {
    ...document,
    _retrieval_score: Number(score) || 0,
    _matched_queries: matchedQuery ? [matchedQuery] : [],
    _retrieval_sources: [retrievalSource],
  });
}

async function fetchCollectionCatalog(knowledgeScope) {
  const cacheMs = readNumber(
    "OUTLINE_CATALOG_CACHE_MS",
    DEFAULT_CATALOG_CACHE_MS
  );
  const maxDocuments = readNumber(
    "OUTLINE_MAX_CATALOG_DOCUMENTS",
    DEFAULT_MAX_CATALOG_DOCUMENTS
  );

  if (
    catalogCache.collectionId === knowledgeScope.collection_id &&
    catalogCache.expiresAt > Date.now() &&
    catalogCache.documents.length > 0
  ) {
    return catalogCache.documents;
  }

  const documents = [];
  const pageLimit = 100;

  for (let offset = 0; offset < maxDocuments; offset += pageLimit) {
    const response = await listOutlineDocuments({
      limit: pageLimit,
      offset,
    });

    const page = asArray(response).map(extractSearchDocument).filter(Boolean);
    documents.push(...page);

    if (page.length < pageLimit) break;
  }

  const uniqueMap = new Map();
  for (const document of documents) {
    const key = document?.id || document?.urlId || document?.url;
    if (!key || !document?.title) continue;

    if (
      document.collectionId &&
      document.collectionId !== knowledgeScope.collection_id
    ) {
      continue;
    }

    uniqueMap.set(key, document);
  }

  catalogCache.collectionId = knowledgeScope.collection_id;
  catalogCache.expiresAt = Date.now() + cacheMs;
  catalogCache.documents = [...uniqueMap.values()];

  console.log(
    `📚 Outline catalog cached: ${catalogCache.documents.length} dokumen ` +
      `dari ${knowledgeScope.collection_name}`
  );

  return catalogCache.documents;
}

async function searchUsingVariants({
  searchQueries,
  safeLimit,
  knowledgeScope,
}) {
  const candidateMap = new Map();
  const searchFailures = [];
  let pagination = null;

  for (let queryIndex = 0; queryIndex < searchQueries.length; queryIndex += 1) {
    const searchQuery = searchQueries[queryIndex];

    try {
      const response = await searchOutlineDocuments(searchQuery, {
        limit: safeLimit,
        offset: 0,
      });

      if (!pagination) pagination = response?.pagination || null;

      const items = asArray(response);

      items.forEach((item, rank) => {
        const document = extractSearchDocument(item);
        if (!document || !(document.id || document.urlId)) return;

        if (
          document.collectionId &&
          document.collectionId !== knowledgeScope.collection_id
        ) {
          return;
        }

        const titleScore = titleSimilarityScore(document.title, [searchQuery]);
        const queryPriorityScore =
          Math.max(searchQueries.length - queryIndex, 1) * 100;
        const rankScore = Math.max(safeLimit - rank, 1) * 20;

        mergeCandidate(candidateMap, document, {
          score: titleScore + queryPriorityScore + rankScore,
          matchedQuery: searchQuery,
          retrievalSource: "documents.search",
        });
      });
    } catch (error) {
      searchFailures.push({
        query: searchQuery,
        error: error?.message || String(error),
      });
    }
  }

  return {
    candidateMap,
    searchFailures,
    pagination,
  };
}

async function addCatalogCandidates({
  candidateMap,
  searchQueries,
  input,
  safeLimit,
  knowledgeScope,
}) {
  let catalog = [];

  try {
    catalog = await fetchCollectionCatalog(knowledgeScope);
  } catch (error) {
    console.warn("⚠️ Gagal membaca katalog Outline:", error.message);
    return {
      catalogSize: 0,
      llmRerank: null,
      catalogError: error.message,
    };
  }

  const deterministicRanking = catalog
    .map((document) => ({
      document,
      score: titleSimilarityScore(document.title, searchQueries),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  for (const item of deterministicRanking.slice(0, safeLimit * 3)) {
    mergeCandidate(candidateMap, item.document, {
      score: item.score + 500,
      matchedQuery: "catalog-title-match",
      retrievalSource: "documents.list:title_match",
    });
  }

  let llmRerank = null;

  try {
    const rerankPool =
      deterministicRanking.length > 0
        ? deterministicRanking.map((item) => item.document)
        : catalog.slice(0, 20);

    llmRerank = await rerankKnowledgeTitles({
      query: input.query,
      subject: input.subject,
      description: input.description,
      project: input.project,
      previousTopic: input.previousTopic,
      candidates: rerankPool,
      limit: safeLimit,
    });

    const selectedIdSet = new Set(llmRerank.selected_ids || []);

    rerankPool.forEach((document, index) => {
      if (!selectedIdSet.has(String(document.id))) return;

      mergeCandidate(candidateMap, document, {
        score: 2_000 - index * 20,
        matchedQuery: "llm-title-rerank",
        retrievalSource: "documents.list:llm_rerank",
      });
    });
  } catch (error) {
    console.warn("⚠️ LLM title reranker gagal:", error.message);
    llmRerank = {
      selected_ids: [],
      reason: `Reranker gagal: ${error.message}`,
    };
  }

  return {
    catalogSize: catalog.length,
    llmRerank,
    catalogError: null,
  };
}

function normalizeDocument(
  detailResponse,
  fallback = {},
  maxChars,
  knowledgeScope
) {
  const detail = extractDetailDocument(detailResponse) || {};
  const merged = { ...fallback, ...detail };

  const content = cleanDocumentText(
    merged.text || merged.content || merged.markdown || merged.body
  ).slice(0, maxChars);

  return {
    id: merged.id || fallback.id || null,
    title:
      merged.title || fallback.title || "Dokumen Outline tanpa judul",
    content,
    url: buildOutlineDocumentUrl(merged),
    collection_id:
      merged.collectionId ||
      fallback.collectionId ||
      knowledgeScope.collection_id ||
      null,
    collection_name: knowledgeScope.collection_name,
    parent_document_id: merged.parentDocumentId || null,
    updated_at: merged.updatedAt || fallback.updatedAt || null,
    created_at: merged.createdAt || fallback.createdAt || null,
    matched_queries: Array.isArray(fallback._matched_queries)
      ? fallback._matched_queries
      : [],
    retrieval_sources: Array.isArray(fallback._retrieval_sources)
      ? fallback._retrieval_sources
      : [],
    retrieval_score: Number(fallback._retrieval_score || 0),
    source: "outline",
    source_type: "super_knowledge_base",
  };
}

/**
 * Hybrid dynamic retrieval:
 * 1. Deterministic query extraction dari query + subject + description + project.
 * 2. LLM bilingual query planning.
 * 3. Multi-query documents.search.
 * 4. Collection catalog title matching.
 * 5. LLM semantic title reranking jika search kaku/kosong.
 * 6. documents.info untuk mengambil isi dokumen sebenarnya.
 */
export async function retrieveOutlineKnowledge(input, options = {}) {
  const normalizedInput = normalizeRetrievalInput(input, options);
  const {
    query,
    subject,
    description,
    project,
    previousTopic,
    limit,
    requestedCollectionId,
  } = normalizedInput;

  if (!query && !subject && !description && !project && !previousTopic) {
    throw new Error(
      "Query, subject, description, project, atau previous topic tidak boleh semuanya kosong."
    );
  }

  const knowledgeScope = getOutlineKnowledgeScope();

  if (
    requestedCollectionId &&
    requestedCollectionId !== knowledgeScope.collection_id
  ) {
    console.warn(
      `⚠️ Collection berbeda diabaikan. Knowledge tetap dari ${knowledgeScope.collection_name}.`
    );
  }

  const maxDocumentChars = readNumber(
    "OUTLINE_MAX_DOCUMENT_CHARS",
    DEFAULT_MAX_DOCUMENT_CHARS
  );
  const maxTotalChars = readNumber(
    "OUTLINE_MAX_TOTAL_CHARS",
    DEFAULT_MAX_TOTAL_CHARS
  );
  const safeLimit = Math.min(
    Math.max(Number(limit) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );

  const deterministicQueries = buildDeterministicQueries(normalizedInput);

  let llmPlan = {
    detected_language: "unknown",
    intent: "knowledge_search",
    technical_entities: [],
    search_queries: [],
    title_hints: [],
    reason: "LLM planner belum dijalankan.",
  };

  try {
    llmPlan = await planKnowledgeSearch({
      query,
      subject,
      description,
      project,
      previousTopic,
    });
  } catch (error) {
    console.warn("⚠️ LLM knowledge query planner gagal:", error.message);
    llmPlan.reason = `Planner gagal, fallback deterministic digunakan: ${error.message}`;
  }

  const searchQueries = uniqueStrings([
    ...llmPlan.title_hints,
    ...llmPlan.search_queries,
    ...llmPlan.technical_entities,
    ...deterministicQueries,
  ]);

  console.log("🧠 Dynamic knowledge search plan:", {
    input: {
      query: query.slice(0, 250),
      subject: subject.slice(0, 150),
      description: description.slice(0, 300),
      project: project.slice(0, 100),
      previous_topic: previousTopic.slice(0, 150),
    },
    language: llmPlan.detected_language,
    intent: llmPlan.intent,
    queries: searchQueries,
  });

  const {
    candidateMap,
    searchFailures,
    pagination,
  } = await searchUsingVariants({
    searchQueries,
    safeLimit,
    knowledgeScope,
  });

  const catalogResult = await addCatalogCandidates({
    candidateMap,
    searchQueries,
    input: normalizedInput,
    safeLimit,
    knowledgeScope,
  });

  const candidates = [...candidateMap.values()].sort(
    (a, b) => b._retrieval_score - a._retrieval_score
  );

  if (candidates.length === 0) {
    return {
      source: "outline",
      source_type: "super_knowledge_base",
      retrieval_mode: "hybrid_llm_bilingual_catalog",
      query,
      subject,
      description,
      project,
      previous_topic: previousTopic,
      detected_language: llmPlan.detected_language,
      intent: llmPlan.intent,
      search_queries: searchQueries,
      title_hints: llmPlan.title_hints,
      knowledge_scope: {
        collection_id: knowledgeScope.collection_id,
        collection_name: knowledgeScope.collection_name,
      },
      count: 0,
      documents: [],
      catalog_size: catalogResult.catalogSize,
      llm_rerank: catalogResult.llmRerank,
      search_failures: searchFailures,
      partial_failures: [],
      pagination,
      answer_language: llmPlan.detected_language === "en" ? "en" : "id",
    };
  }

  const selectedCandidates = candidates.slice(0, safeLimit);

  const settled = await Promise.allSettled(
    selectedCandidates.map(async (candidate) => {
      const lookupId = candidate.id || candidate.urlId;
      const detailResponse = await getOutlineDocument(lookupId);

      return normalizeDocument(
        detailResponse,
        candidate,
        maxDocumentChars,
        knowledgeScope
      );
    })
  );

  const documents = [];
  const partialFailures = [];
  let totalChars = 0;

  settled.forEach((result, index) => {
    const candidate = selectedCandidates[index];

    if (result.status === "rejected") {
      partialFailures.push({
        id: candidate?.id || candidate?.urlId || null,
        title: candidate?.title || null,
        error: result.reason?.message || String(result.reason),
      });
      return;
    }

    const document = result.value;

    if (
      document.collection_id &&
      document.collection_id !== knowledgeScope.collection_id
    ) {
      partialFailures.push({
        id: document.id,
        title: document.title,
        error: "Dokumen berasal dari collection yang tidak diizinkan.",
      });
      return;
    }

    if (!document.content) return;

    const remaining = maxTotalChars - totalChars;
    if (remaining <= 0) return;

    const limitedDocument = {
      ...document,
      content: document.content.slice(0, remaining),
    };

    totalChars += limitedDocument.content.length;
    documents.push(limitedDocument);
  });

  console.log(
    `📚 Outline retrieval [${knowledgeScope.collection_name}]: ` +
      `hasil=${documents.length} total_chars=${totalChars} ` +
      `queries=${searchQueries.length} catalog=${catalogResult.catalogSize}`
  );

  return {
    source: "outline",
    source_type: "super_knowledge_base",
    retrieval_mode: "hybrid_llm_bilingual_catalog",
    query,
    subject,
    description,
    project,
    previous_topic: previousTopic,
    detected_language: llmPlan.detected_language,
    intent: llmPlan.intent,
    planner_reason: llmPlan.reason,
    technical_entities: llmPlan.technical_entities,
    search_queries: searchQueries,
    title_hints: llmPlan.title_hints,
    answer_language: llmPlan.detected_language === "en" ? "en" : "id",
    knowledge_scope: {
      collection_id: knowledgeScope.collection_id,
      collection_name: knowledgeScope.collection_name,
    },
    count: documents.length,
    documents,
    catalog_size: catalogResult.catalogSize,
    llm_rerank: catalogResult.llmRerank,
    search_failures: searchFailures,
    partial_failures: partialFailures,
    pagination,
  };
}
