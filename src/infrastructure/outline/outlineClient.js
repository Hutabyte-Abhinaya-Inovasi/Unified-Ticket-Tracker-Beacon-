// src/infrastructure/outline/outlineClient.js
import { env } from "../../config/env.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_LIST_LIMIT = 100;

function readConfigValue(name, fallback = undefined) {
  const value = env?.[name] ?? process.env[name] ?? fallback;
  return typeof value === "string" ? value.trim() : value;
}

function getOutlineConfig() {
  const baseUrl = String(readConfigValue("OUTLINE_BASE_URL", ""))
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");

  const apiKey = String(readConfigValue("OUTLINE_API_KEY", ""));
  const collectionId = String(readConfigValue("OUTLINE_COLLECTION_ID", ""));
  const collectionName = String(
    readConfigValue("OUTLINE_COLLECTION_NAME", "PT Tricada Intronik")
  );
  const timeoutMs = Number(
    readConfigValue("OUTLINE_API_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)
  );
  const maxRetries = Number(
    readConfigValue("OUTLINE_API_MAX_RETRIES", DEFAULT_MAX_RETRIES)
  );

  if (!baseUrl) {
    throw new Error("OUTLINE_BASE_URL belum dikonfigurasi.");
  }

  if (!apiKey) {
    throw new Error("OUTLINE_API_KEY belum dikonfigurasi.");
  }

  if (!collectionId) {
    throw new Error(
      "OUTLINE_COLLECTION_ID belum dikonfigurasi. Collection knowledge wajib ditentukan."
    );
  }

  return {
    baseUrl,
    apiKey,
    collectionId,
    collectionName,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,
    maxRetries:
      Number.isFinite(maxRetries) && maxRetries >= 0
        ? maxRetries
        : DEFAULT_MAX_RETRIES,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function readResponseBody(response) {
  const raw = await response.text();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/**
 * Memanggil endpoint RPC Outline, misalnya:
 * - documents.search
 * - documents.info
 * - documents.list
 */
export async function callOutlineApi(endpoint, payload = {}) {
  const config = getOutlineConfig();
  const cleanEndpoint = String(endpoint || "")
    .replace(/^\/+/, "")
    .replace(/^api\//, "");
  const url = `${config.baseUrl}/api/${cleanEndpoint}`;

  let lastError;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const body = await readResponseBody(response);

      if (!response.ok || body?.ok === false) {
        const message = body?.message || body?.error || `HTTP ${response.status}`;
        const error = new Error(
          `Outline API ${cleanEndpoint} gagal: ${message}`
        );
        error.status = response.status;
        error.endpoint = cleanEndpoint;
        error.outlineError = body?.error;

        if (attempt < config.maxRetries && shouldRetry(response.status)) {
          lastError = error;
          await sleep(500 * 2 ** attempt);
          continue;
        }

        throw error;
      }

      return body;
    } catch (error) {
      const normalizedError =
        error?.name === "AbortError"
          ? new Error(
              `Outline API ${cleanEndpoint} timeout setelah ${config.timeoutMs}ms`
            )
          : error;

      lastError = normalizedError;

      const isNetworkError =
        normalizedError?.name === "TypeError" ||
        normalizedError?.code === "ECONNRESET" ||
        normalizedError?.code === "ETIMEDOUT";

      if (attempt < config.maxRetries && isNetworkError) {
        await sleep(500 * 2 ** attempt);
        continue;
      }

      throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`Outline API ${cleanEndpoint} gagal tanpa detail.`);
}

/**
 * Search selalu dikunci ke collection dari .env.
 */
export async function searchOutlineDocuments(
  query,
  { limit = 3, offset = 0, collectionId } = {}
) {
  const config = getOutlineConfig();
  const cleanQuery = String(query || "").replace(/\s+/g, " ").trim();

  if (!cleanQuery) {
    throw new Error("Query pencarian Outline tidak boleh kosong.");
  }

  if (collectionId && collectionId !== config.collectionId) {
    console.warn(
      `⚠️ Collection ${collectionId} diabaikan. Search dikunci ke ${config.collectionName}.`
    );
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 3, 1), 25);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  console.log(
    `🔎 Outline search: "${cleanQuery}" di collection "${config.collectionName}"`
  );

  return callOutlineApi("documents.search", {
    query: cleanQuery,
    limit: safeLimit,
    offset: safeOffset,
    collectionId: config.collectionId,
  });
}

/**
 * Mengambil katalog judul dokumen dari collection yang dikunci.
 * Digunakan sebagai fallback semantic-title matching ketika documents.search kosong.
 */
export async function listOutlineDocuments({
  limit = DEFAULT_LIST_LIMIT,
  offset = 0,
  collectionId,
} = {}) {
  const config = getOutlineConfig();

  if (collectionId && collectionId !== config.collectionId) {
    console.warn(
      `⚠️ Collection ${collectionId} diabaikan. Listing dikunci ke ${config.collectionName}.`
    );
  }

  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  return callOutlineApi("documents.list", {
    collectionId: config.collectionId,
    limit: safeLimit,
    offset: safeOffset,
  });
}

export async function getOutlineDocument(id) {
  const config = getOutlineConfig();
  const cleanId = String(id || "").trim();

  if (!cleanId) {
    throw new Error("ID dokumen Outline tidak tersedia.");
  }

  const result = await callOutlineApi("documents.info", { id: cleanId });
  const document =
    result?.data?.document || result?.data || result?.document || result;

  if (
    document?.collectionId &&
    document.collectionId !== config.collectionId
  ) {
    throw new Error(
      `Dokumen ${cleanId} bukan berasal dari collection ${config.collectionName}.`
    );
  }

  return result;
}

export function buildOutlineDocumentUrl(document = {}) {
  const { baseUrl } = getOutlineConfig();
  const rawUrl = document.url || document.publishedUrl;

  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }

  if (rawUrl) {
    return `${baseUrl}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
  }

  if (document.urlId) {
    return `${baseUrl}/doc/${document.urlId}`;
  }

  return null;
}

export function getOutlineKnowledgeScope() {
  const config = getOutlineConfig();

  return {
    collection_id: config.collectionId,
    collection_name: config.collectionName,
    base_url: config.baseUrl,
  };
}
