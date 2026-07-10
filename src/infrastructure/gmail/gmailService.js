import { google } from "googleapis";
import { htmlToText } from "html-to-text";

/**
 * Decode base64 URL-safe Gmail data
 */
function decodeBase64(data) {
  const buff = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buff.toString("utf-8");
}

/**
 * Extract email body from payload
 * Prefer text/plain, fallback ke text/html
 */
function extractBody(payload) {
  // text/plain langsung
  if (payload.body?.data) {
    return decodeBase64(payload.body.data);
  }

  // cek bagian multipart
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64(part.body.data);
      }

      // nested parts
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === "text/plain" && sub.body?.data) {
            return decodeBase64(sub.body.data);
          }
        }
      }
    }

    // fallback text/html
    const htmlPart = payload.parts.find(p => p.mimeType === "text/html" && p.body?.data);
    if (htmlPart) return decodeBase64(htmlPart.body.data);
  }

  return "(Tidak ada isi teks)";
}

/**
 * Ambil email terbaru
 * @param {OAuth2Client} auth - objek auth Google
 */
export async function getLatestEmail(auth) {
  const gmail = google.gmail({ version: "v1", auth });

  // Ambil 1 email terbaru di inbox
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 1,
    q: "in:inbox"
  });

  if (!res.data.messages) return null;

  const messageId = res.data.messages[0].id;

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full"
  });

  //console.log(msg.data);

  const headers = msg.data.payload.headers;
  const threadId = msg.data.threadId;
  const from = headers.find(h=>h.name === "From")?.value || "-";
  const to = headers.find(h=>h.name === "To")?.value || "-";
  const cc = headers.find(h => h.name === "Cc")?.value || "-";
  const subject = headers.find(h => h.name === "Subject")?.value || "-";
  const date = headers.find(h=> h.name === "Date")?.value || "";

  // Ambil body
  let body = extractBody(msg.data.payload);

  // Convert HTML ke plain text
  body = htmlToText(body, {
    wordwrap: 130,
    ignoreImage: true,
    ignoreHref: true
  });

  const attachmentCount = msg.data.payload.parts?.filter(part=>part.filename).length || 0;

  return {
    id: messageId,
    threadId,
    from,
    to,
    cc,
    subject,
    body,
    date,
    attachmentCount
  };
}

// hapus saja karena tidak tepakai di email ! 
// tergantung update jikalau ingin memakai code (migrasi !)