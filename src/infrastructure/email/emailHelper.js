// src/infrastructure/email/emailHelper.js

/**
 * Ekstraksi mention / nama orang yang di-tag (@nama atau @email) dari body email atau HTML.
 * Mendukung format:
 * - "Dear pak @Andri Sofyana mailto:andri.sofyana@phincon.com Baik, segera di push pak"
 * - "Dear pak @Andri Sofyana<mailto:andri.sofyana@phincon.com> Sudah di push ya pak."
 * - Tag HTML Outlook/Teams: <a class="...mention..." href="mailto:andri.sofyana@phincon.com">@Andri Sofyana</a>
 * - Format email langsung: @david.zefanya@tritronik.com
 * - Format nama: @Khairul Anwar, @Irfan Salman Nurdin
 *
 * @param {string} bodyText - Konten teks email
 * @param {string} html - Konten HTML email (jika ada)
 * @returns {Array<{name: string, email: string}>} Daftar mention yang ditemukan
 */
export function extractEmailMentions(bodyText = "", html = "") {
  const mentions = [];
  const seen = new Set();

  function addMention(rawName, rawEmail = "") {
    let name = (rawName || "").trim().replace(/^@/, "").trim();
    let email = (rawEmail || "").trim();

    if (!name && email) {
      name = email.split("@")[0];
    }
    if (!name || name.length < 2) return;

    // Bersihkan prefix gelar/sapaan jika terbawa (misal: "pak Andri Sofyana" -> "Andri Sofyana")
    name = name.replace(/^(pak|mas|bu|mbak|bapak|ibu)\s+/i, "").trim();

    // Abaikan jika false positive sistemik
    const lower = name.toLowerCase();
    if (
      lower.startsWith("email") ||
      lower.includes("http") ||
      lower.startsWith("sharepoint") ||
      lower.includes("teams.microsoft.com")
    ) {
      return;
    }

    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ name, email });
    } else if (email) {
      const existing = mentions.find((m) => m.name.toLowerCase() === key);
      if (existing && !existing.email) {
        existing.email = email;
      }
    }
  }

  // 1. Ekstraksi dari HTML mention class (Outlook Web / Teams / Office 365)
  if (html && typeof html === "string") {
    const htmlRegex = /<a[^>]*href=["']mailto:([^"']+)["'][^>]*class=["'][^"']*mention[^"']*["'][^>]*>@?([^<]+)<\/a>/gi;
    let m;
    while ((m = htmlRegex.exec(html)) !== null) {
      addMention(m[2], m[1]);
    }

    const htmlRegex2 = /<a[^>]*class=["'][^"']*mention[^"']*["'][^>]*href=["']mailto:([^"']+)["'][^>]*>@?([^<]+)<\/a>/gi;
    while ((m = htmlRegex2.exec(html)) !== null) {
      addMention(m[2], m[1]);
    }
  }

  // 2. Ekstraksi dari plain text
  if (bodyText && typeof bodyText === "string") {
    // 2a. Pola: @Nama <mailto:email> atau @Nama mailto:email
    const mentionMailtoRegex = /@([A-Za-z][A-Za-z0-9_.\s]{1,40}?)(?:<mailto:([^>]+)>|mailto:([^\s]+))/gi;
    let mm;
    while ((mm = mentionMailtoRegex.exec(bodyText)) !== null) {
      addMention(mm[1], mm[2] || mm[3]);
    }

    // 2b. Format email langsung: @user@domain.com
    const emailMentionRegex = /@([a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+)/g;
    let em;
    while ((em = emailMentionRegex.exec(bodyText)) !== null) {
      addMention(em[1].split("@")[0], em[1]);
    }

    // 2c. Format @Nama (1-3 kata huruf besar tanpa newline)
    const cleanForNames = bodyText
      .replace(/<mailto:[^>]+>/gi, "")
      .replace(/mailto:[^\s]+/gi, "")
      .replace(/[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+/g, "");

    const plainNameRegex = /@([A-Z][a-zA-Z0-9_.-]*(?:[ \t]+[A-Z][a-zA-Z0-9_.-]*){0,3})(?=[ \t]*[.,;:!?\r\n<]|$|[ \t]+(?:sudah|baik|segera|tolong|mohon|terima|push|di\b|ke\b))/gi;
    let pnm;
    while ((pnm = plainNameRegex.exec(cleanForNames)) !== null) {
      addMention(pnm[1]);
    }
  }

  return mentions;
}
