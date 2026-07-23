import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { PublicClientApplication } from "@azure/msal-node";
import { saveRawIntakeMessage } from "../../database/supabase.js";
import { processRawMessage } from "../../usecases/processRawMessage.js";

const enabled = String(process.env.OUTLOOK_ENABLED || "false").toLowerCase() === "true";
const tenantId = process.env.AZURE_TENANT_ID;
const clientId = process.env.AZURE_CLIENT_ID;
const pollIntervalMs = Number(process.env.OUTLOOK_POLL_INTERVAL_MS || 60000);
const expectedMailbox = (process.env.OUTLOOK_MAILBOX || "").toLowerCase();
const cachePath = path.resolve("auth_info", "outlook-msal-cache.json");
const scopes = ["User.Read", "Mail.Read"];

let pollTimer = null;
let pollRunning = false;

const cachePlugin = {
  beforeCacheAccess: async (context) => {
    try {
      const cache = await fs.readFile(cachePath, "utf8");
      context.tokenCache.deserialize(cache);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  },
  afterCacheAccess: async (context) => {
    if (!context.cacheHasChanged) return;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, context.tokenCache.serialize(), "utf8");
  },
};

function createMsalClient() {
  return new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: { cachePlugin },
  });
}

const msalClient = createMsalClient();

async function getAccessToken() {
  const accounts = await msalClient.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    try {
      const result = await msalClient.acquireTokenSilent({
        account: accounts[0],
        scopes,
      });
      return result.accessToken;
    } catch (error) {
      console.warn(`⚠️ Token Outlook lama tidak dapat dipakai: ${error.message}`);
    }
  }

  const result = await msalClient.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      console.log("\n🔐 Login Microsoft 365 diperlukan");
      console.log(response.message);
    },
  });

  if (!result?.accessToken) {
    throw new Error("Microsoft 365 tidak mengembalikan access token");
  }

  const signedInMailbox = (result.account?.username || "").toLowerCase();
  console.log(`✅ Login Microsoft 365 berhasil: ${result.account?.username || "akun Outlook"}`);
  if (expectedMailbox && signedInMailbox && signedInMailbox !== expectedMailbox) {
    console.warn(`⚠️ Akun login ${signedInMailbox} berbeda dari OUTLOOK_MAILBOX=${expectedMailbox}`);
  }
  return result.accessToken;
}

async function graphRequest(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: 'outlook.body-content-type="text"',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Microsoft Graph ${response.status}: ${detail}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function getUnreadMessages(token) {
  const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  url.searchParams.set("$filter", "isRead eq false");
  url.searchParams.set("$orderby", "receivedDateTime asc");
  url.searchParams.set("$top", "10");
  url.searchParams.set(
    "$select",
    "id,internetMessageId,conversationId,subject,from,receivedDateTime,body,bodyPreview,hasAttachments"
  );

  const data = await graphRequest(token, url.toString());
  return data?.value || [];
}

async function markMessageAsRead(token, messageId) {
  await graphRequest(
    token,
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    }
  );
}

async function processOutlookMessage(token, message) {
  const senderName = message.from?.emailAddress?.name || "Unknown";
  const senderAddress = message.from?.emailAddress?.address || "unknown";
  const subject = message.subject || "(Tanpa subjek)";
  const body = message.body?.content || message.bodyPreview || "";

  const rawPayload = {
    source_channel: "email",
    source_ref: `outlook:${message.conversationId || senderAddress}`,
    sender: `${senderName} (${senderAddress})`,
    received_at: message.receivedDateTime || new Date().toISOString(),
    body_text: `Subject: ${subject}\n\n${body}`.trim(),
    attachments: message.hasAttachments ? { has_attachments: true } : null,
    raw_payload: {
      provider: "microsoft365",
      group_name: subject,
      graph_message_id: message.id,
      internet_message_id: message.internetMessageId,
      conversation_id: message.conversationId,
    },
    idempotency_key: `outlook:${message.id}`,
  };

  const inserted = await saveRawIntakeMessage(rawPayload);
  if (!inserted) {
    console.warn(`⚠️ Email tidak disimpan, sehingga belum ditandai read: ${subject}`);
    return;
  }

  await processRawMessage({ ...rawPayload, ...inserted });
  // Email tidak ditandai sudah dibaca karena permission hanya Mail.Read.
  console.log(`✅ Email Outlook selesai diproses: ${subject}`);
}

async function pollOutlook() {
  if (pollRunning) return;
  pollRunning = true;

  try {
    const token = await getAccessToken();
    const messages = await getUnreadMessages(token);

    if (messages.length > 0) {
      console.log(`📬 Ditemukan ${messages.length} email Outlook unread`);
    }

    for (const message of messages) {
      try {
        await processOutlookMessage(token, message);
      } catch (error) {
        console.error(`❌ Gagal memproses email Outlook: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`❌ Outlook listener error: ${error.message}`);
  } finally {
    pollRunning = false;
  }
}

export function startOutlookListener() {
  if (!enabled) {
    console.log("⏭️ Outlook listener nonaktif (OUTLOOK_ENABLED=false)");
    return;
  }

  if (!tenantId || !clientId) {
    console.error("❌ AZURE_TENANT_ID atau AZURE_CLIENT_ID belum diisi");
    return;
  }

  console.log(`📧 Microsoft 365 Outlook Listener aktif (${pollIntervalMs / 1000} detik)`);
  void pollOutlook();
  pollTimer = setInterval(() => void pollOutlook(), pollIntervalMs);
}

export function stopOutlookListener() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
