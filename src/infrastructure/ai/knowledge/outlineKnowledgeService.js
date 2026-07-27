// src/infrastructure/ai/knowledge/outlineKnowledgeService.js

import { env } from "../../../config/env.js";

import {
  buildOutlineDocumentUrl,
  getOutlineDocument,
  getOutlineKnowledgeScope,
  searchOutlineDocuments,
} from "../../outline/outlineClient.js";

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;

const DEFAULT_MAX_DOCUMENT_CHARS = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 30_000;

function readNumber(name, fallback) {
  const value = Number(
    env?.[name] ??
    process.env[name] ??
    fallback
  );

  return (
    Number.isFinite(value) &&
    value > 0
  )
    ? value
    : fallback;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.data)) {
    return value.data;
  }

  if (Array.isArray(value?.documents)) {
    return value.documents;
  }

  return [];
}

/**
 * Mengambil object dokumen dari hasil documents.search.
 *
 * Outline terkadang mengembalikan:
 * {
 *   document: {...}
 * }
 *
 * atau langsung:
 * {
 *   id,
 *   title,
 *   ...
 * }
 */
function extractSearchDocument(item = {}) {
  return (
    item.document ||
    item.data?.document ||
    item.data ||
    item
  );
}

/**
 * Mengambil object dokumen dari hasil documents.info.
 */
function extractDetailDocument(response = {}) {
  return (
    response?.data?.document ||
    response?.data ||
    response?.document ||
    response
  );
}

function cleanDocumentText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Mendukung dua bentuk pemanggilan:
 *
 * retrieveOutlineKnowledge(
 *   "cara membuka instance",
 *   { limit: 3 }
 * )
 *
 * atau:
 *
 * retrieveOutlineKnowledge({
 *   query: "cara membuka instance",
 *   limit: 3
 * })
 */
function normalizeRetrievalInput(
  input,
  options = {}
) {
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input)
  ) {
    return {
      query: String(
        input.query || ""
      )
        .replace(/\s+/g, " ")
        .trim(),

      limit:
        input.limit ??
        options.limit ??
        DEFAULT_LIMIT,

      requestedCollectionId:
        input.collectionId ||
        input.collection_id ||
        options.collectionId ||
        null,
    };
  }

  return {
    query: String(input || "")
      .replace(/\s+/g, " ")
      .trim(),

    limit:
      options.limit ??
      DEFAULT_LIMIT,

    requestedCollectionId:
      options.collectionId ||
      null,
  };
}

function normalizeDocument(
  detailResponse,
  fallback = {},
  maxChars,
  knowledgeScope
) {
  const detail =
    extractDetailDocument(
      detailResponse
    ) || {};

  const merged = {
    ...fallback,
    ...detail,
  };

  const content = cleanDocumentText(
    merged.text ||
    merged.content ||
    merged.markdown ||
    merged.body
  ).slice(0, maxChars);

  return {
    id:
      merged.id ||
      fallback.id ||
      null,

    title:
      merged.title ||
      fallback.title ||
      "Dokumen Outline tanpa judul",

    content,

    url:
      buildOutlineDocumentUrl(
        merged
      ),

    collection_id:
      merged.collectionId ||
      fallback.collectionId ||
      knowledgeScope.collection_id ||
      null,

    collection_name:
      knowledgeScope.collection_name,

    parent_document_id:
      merged.parentDocumentId ||
      null,

    updated_at:
      merged.updatedAt ||
      fallback.updatedAt ||
      null,

    created_at:
      merged.createdAt ||
      fallback.createdAt ||
      null,

    source: "outline",

    source_type:
      "super_knowledge_base",
  };
}

function deduplicateCandidates(
  candidates
) {
  const uniqueDocuments =
    new Map();

  for (const candidate of candidates) {
    const key =
      candidate.id ||
      candidate.urlId ||
      candidate.url;

    if (!key) {
      continue;
    }

    if (!uniqueDocuments.has(key)) {
      uniqueDocuments.set(
        key,
        candidate
      );
    }
  }

  return [
    ...uniqueDocuments.values(),
  ];
}

/**
 * Search langsung ke Outline collection
 * PT Tricada Intronik.
 *
 * Tidak menggunakan:
 * - embedding;
 * - pgvector;
 * - tabel knowledge_base Supabase.
 */
export async function retrieveOutlineKnowledge(
  input,
  options = {}
) {
  const {
    query,
    limit,
    requestedCollectionId,
  } = normalizeRetrievalInput(
    input,
    options
  );

  if (!query) {
    throw new Error(
      "Query knowledge Outline tidak boleh kosong."
    );
  }

  const knowledgeScope =
    getOutlineKnowledgeScope();

  /*
   * Collection dikunci di backend.
   * Bila AI atau kode lain mengirim collection berbeda,
   * collection tersebut tidak akan digunakan.
   */
  if (
    requestedCollectionId &&
    requestedCollectionId !==
      knowledgeScope.collection_id
  ) {
    console.warn(
      "⚠️ Permintaan collection berbeda diabaikan. " +
      `Knowledge tetap diambil dari ` +
      `"${knowledgeScope.collection_name}".`
    );
  }

  const maxDocumentChars =
    readNumber(
      "OUTLINE_MAX_DOCUMENT_CHARS",
      DEFAULT_MAX_DOCUMENT_CHARS
    );

  const maxTotalChars =
    readNumber(
      "OUTLINE_MAX_TOTAL_CHARS",
      DEFAULT_MAX_TOTAL_CHARS
    );

  const safeLimit = Math.min(
    Math.max(
      Number(limit) ||
      DEFAULT_LIMIT,
      1
    ),
    MAX_LIMIT
  );

  /*
   * outlineClient.js otomatis memasukkan
   * OUTLINE_COLLECTION_ID ke documents.search.
   */
  const searchResponse =
    await searchOutlineDocuments(
      query,
      {
        limit: safeLimit,
        offset: 0,
      }
    );

  const searchItems =
    asArray(searchResponse);

  const candidates =
    deduplicateCandidates(
      searchItems
        .map(
          extractSearchDocument
        )
        .filter(
          (document) => {
            if (
              !document ||
              !(
                document.id ||
                document.urlId
              )
            ) {
              return false;
            }

            /*
             * Bila hasil search mencantumkan collectionId,
             * pastikan collection-nya benar.
             *
             * Bila collectionId tidak tersedia,
             * tetap diteruskan karena getOutlineDocument()
             * akan memvalidasi ulang hasil documents.info.
             */
            if (
              document.collectionId &&
              document.collectionId !==
                knowledgeScope.collection_id
            ) {
              console.warn(
                `⚠️ Dokumen "${document.title || document.id}" ` +
                "dilewati karena berasal dari collection lain."
              );

              return false;
            }

            return true;
          }
        )
    );

  if (candidates.length === 0) {
    return {
      source: "outline",

      source_type:
        "super_knowledge_base",

      query,

      knowledge_scope: {
        collection_id:
          knowledgeScope.collection_id,

        collection_name:
          knowledgeScope.collection_name,
      },

      count: 0,

      documents: [],

      partial_failures: [],

      pagination:
        searchResponse?.pagination ||
        null,
    };
  }

  /*
   * Mengambil isi lengkap dokumen secara paralel.
   *
   * getOutlineDocument() juga memastikan dokumen
   * berasal dari collection PT Tricada Intronik.
   */
  const settled =
    await Promise.allSettled(
      candidates
        .slice(0, safeLimit)
        .map(
          async (candidate) => {
            const lookupId =
              candidate.id ||
              candidate.urlId;

            const detailResponse =
              await getOutlineDocument(
                lookupId
              );

            return normalizeDocument(
              detailResponse,
              candidate,
              maxDocumentChars,
              knowledgeScope
            );
          }
        )
    );

  const documents = [];
  const partialFailures = [];

  let totalChars = 0;

  settled.forEach(
    (result, index) => {
      const candidate =
        candidates[index];

      if (
        result.status ===
        "rejected"
      ) {
        partialFailures.push({
          id:
            candidate?.id ||
            candidate?.urlId ||
            null,

          title:
            candidate?.title ||
            null,

          error:
            result.reason?.message ||
            String(
              result.reason
            ),
        });

        return;
      }

      const document =
        result.value;

      if (
        document.collection_id &&
        document.collection_id !==
          knowledgeScope.collection_id
      ) {
        partialFailures.push({
          id:
            document.id,

          title:
            document.title,

          error:
            "Dokumen berasal dari collection yang tidak diizinkan.",
        });

        return;
      }

      if (!document.content) {
        return;
      }

      const remaining =
        maxTotalChars -
        totalChars;

      if (remaining <= 0) {
        return;
      }

      const limitedDocument = {
        ...document,

        content:
          document.content.slice(
            0,
            remaining
          ),
      };

      totalChars +=
        limitedDocument
          .content
          .length;

      documents.push(
        limitedDocument
      );
    }
  );

  console.log(
    `📚 Outline retrieval ` +
    `[${knowledgeScope.collection_name}]: ` +
    `query="${query.slice(0, 100)}" ` +
    `hasil=${documents.length} ` +
    `gagal_detail=${partialFailures.length} ` +
    `total_chars=${totalChars}`
  );

  return {
    source: "outline",

    source_type:
      "super_knowledge_base",

    query,

    knowledge_scope: {
      collection_id:
        knowledgeScope.collection_id,

      collection_name:
        knowledgeScope.collection_name,
    },

    count:
      documents.length,

    documents,

    partial_failures:
      partialFailures,

    pagination:
      searchResponse?.pagination ||
      null,
  };
}