// src/infrastructure/outline/outlineClient.js

import { env } from "../../config/env.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

function readConfigValue(name, fallback = undefined) {
  const value =
    env?.[name] ??
    process.env[name] ??
    fallback;

  return typeof value === "string"
    ? value.trim()
    : value;
}

function getOutlineConfig() {
  const baseUrl = String(
    readConfigValue("OUTLINE_BASE_URL", "")
  )
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");

  const apiKey = String(
    readConfigValue("OUTLINE_API_KEY", "")
  );

  const collectionId = String(
    readConfigValue("OUTLINE_COLLECTION_ID", "")
  );

  const collectionName = String(
    readConfigValue(
      "OUTLINE_COLLECTION_NAME",
      "PT Tricada Intronik"
    )
  );

  const timeoutMs = Number(
    readConfigValue(
      "OUTLINE_API_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS
    )
  );

  const maxRetries = Number(
    readConfigValue(
      "OUTLINE_API_MAX_RETRIES",
      DEFAULT_MAX_RETRIES
    )
  );

  if (!baseUrl) {
    throw new Error(
      "OUTLINE_BASE_URL belum dikonfigurasi."
    );
  }

  if (!apiKey) {
    throw new Error(
      "OUTLINE_API_KEY belum dikonfigurasi."
    );
  }

  if (!collectionId) {
    throw new Error(
      "OUTLINE_COLLECTION_ID belum dikonfigurasi. " +
      "Collection super knowledge base wajib ditentukan."
    );
  }

  return {
    baseUrl,
    apiKey,
    collectionId,
    collectionName,

    timeoutMs:
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,

    maxRetries:
      Number.isFinite(maxRetries) &&
      maxRetries >= 0
        ? maxRetries
        : DEFAULT_MAX_RETRIES,
  };
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function shouldRetry(status) {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

async function readResponseBody(response) {
  const raw = await response.text();

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * Mengambil object dokumen dari berbagai kemungkinan
 * bentuk response Outline.
 */
function extractOutlineDocument(responseBody) {
  if (!responseBody) {
    return null;
  }

  return (
    responseBody.data?.document ||
    responseBody.data ||
    responseBody.document ||
    responseBody
  );
}

/**
 * Memanggil endpoint RPC Outline,
 * misalnya documents.search atau documents.info.
 */
export async function callOutlineApi(
  endpoint,
  payload = {}
) {
  const config = getOutlineConfig();

  const cleanEndpoint = String(
    endpoint || ""
  )
    .replace(/^\/+/, "")
    .replace(/^api\//, "");

  const url =
    `${config.baseUrl}/api/${cleanEndpoint}`;

  let lastError;

  for (
    let attempt = 0;
    attempt <= config.maxRetries;
    attempt += 1
  ) {
    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs
    );

    try {
      const response = await fetch(url, {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${config.apiKey}`,

          "Content-Type":
            "application/json",

          Accept:
            "application/json",
        },

        body: JSON.stringify(payload),

        signal: controller.signal,
      });

      const body =
        await readResponseBody(response);

      if (
        !response.ok ||
        body?.ok === false
      ) {
        const message =
          body?.message ||
          body?.error ||
          `HTTP ${response.status}`;

        const error = new Error(
          `Outline API ${cleanEndpoint} gagal: ${message}`
        );

        error.status = response.status;
        error.endpoint = cleanEndpoint;
        error.outlineError =
          body?.error;

        if (
          attempt < config.maxRetries &&
          shouldRetry(response.status)
        ) {
          lastError = error;

          await sleep(
            500 * 2 ** attempt
          );

          continue;
        }

        throw error;
      }

      return body;
    } catch (error) {
      const normalizedError =
        error?.name === "AbortError"
          ? new Error(
              `Outline API ${cleanEndpoint} timeout ` +
              `setelah ${config.timeoutMs}ms`
            )
          : error;

      lastError = normalizedError;

      const isNetworkError =
        normalizedError?.name ===
          "TypeError" ||
        normalizedError?.code ===
          "ECONNRESET" ||
        normalizedError?.code ===
          "ETIMEDOUT";

      if (
        attempt < config.maxRetries &&
        isNetworkError
      ) {
        await sleep(
          500 * 2 ** attempt
        );

        continue;
      }

      throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw (
    lastError ||
    new Error(
      `Outline API ${cleanEndpoint} gagal tanpa detail.`
    )
  );
}

/**
 * Mencari knowledge HANYA dari collection
 * PT Tricada Intronik yang ditentukan di .env.
 *
 * Parameter collectionId tetap diterima untuk menjaga
 * kompatibilitas dengan kode lama, tetapi tidak dapat
 * mengganti collection yang telah dikunci di backend.
 */
export async function searchOutlineDocuments(
  query,
  {
    limit = 3,
    offset = 0,
    collectionId,
  } = {}
) {
  const config = getOutlineConfig();

  const cleanQuery = String(
    query || ""
  )
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanQuery) {
    throw new Error(
      "Query pencarian Outline tidak boleh kosong."
    );
  }

  /*
   * Jika kode lain mencoba mengirim collection berbeda,
   * abaikan dan tetap gunakan collection dari .env.
   */
  if (
    collectionId &&
    collectionId !== config.collectionId
  ) {
    console.warn(
      "⚠️ Collection ID dari pemanggil diabaikan. " +
      `Knowledge dikunci ke collection ` +
      `"${config.collectionName}" ` +
      `(${config.collectionId}).`
    );
  }

  const safeLimit = Math.min(
    Math.max(
      Number(limit) || 3,
      1
    ),
    10
  );

  const safeOffset = Math.max(
    Number(offset) || 0,
    0
  );

  const payload = {
    query: cleanQuery,
    limit: safeLimit,
    offset: safeOffset,

    // Collection selalu dikunci dari konfigurasi backend.
    collectionId:
      config.collectionId,
  };

  console.log(
    `📚 Outline search: "${cleanQuery}" ` +
    `di collection "${config.collectionName}"`
  );

  const result = await callOutlineApi(
    "documents.search",
    payload
  );

  return {
    ...result,

    knowledge_scope: {
      collection_id:
        config.collectionId,

      collection_name:
        config.collectionName,
    },
  };
}

/**
 * Mengambil detail dokumen dan memastikan dokumen
 * tidak berasal dari collection lain.
 */
export async function getOutlineDocument(id) {
  const config = getOutlineConfig();

  const cleanId = String(
    id || ""
  ).trim();

  if (!cleanId) {
    throw new Error(
      "ID dokumen Outline tidak tersedia."
    );
  }

  const result = await callOutlineApi(
    "documents.info",
    {
      id: cleanId,
    }
  );

  const document =
    extractOutlineDocument(result);

  /*
   * Validasi keamanan kedua.
   * Search sudah dibatasi collectionId,
   * tetapi documents.info juga diverifikasi.
   */
  if (
    document?.collectionId &&
    document.collectionId !==
      config.collectionId
  ) {
    throw new Error(
      `Dokumen "${cleanId}" bukan berasal dari ` +
      `collection super knowledge base ` +
      `"${config.collectionName}".`
    );
  }

  return result;
}

export function buildOutlineDocumentUrl(
  document = {}
) {
  const { baseUrl } =
    getOutlineConfig();

  const rawUrl =
    document.url ||
    document.publishedUrl;

  if (
    rawUrl &&
    /^https?:\/\//i.test(rawUrl)
  ) {
    return rawUrl;
  }

  if (rawUrl) {
    return (
      `${baseUrl}` +
      `${rawUrl.startsWith("/") ? "" : "/"}` +
      `${rawUrl}`
    );
  }

  if (document.urlId) {
    return (
      `${baseUrl}/doc/` +
      `${document.urlId}`
    );
  }

  return null;
}

/**
 * Informasi scope knowledge yang sedang aktif.
 * Bisa digunakan untuk log atau health check.
 */
export function getOutlineKnowledgeScope() {
  const config = getOutlineConfig();

  return {
    collection_id:
      config.collectionId,

    collection_name:
      config.collectionName,

    base_url:
      config.baseUrl,
  };
}