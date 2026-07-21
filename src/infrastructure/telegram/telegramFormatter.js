function escapeHTML(text = "") {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

export function formatCandidateTicket(raw) {

    const email = raw.raw_payload || {};

    return `
📥 <b>KANDIDAT TIKET BARU</b>

📅 Diterima : ${new Date(raw.received_at).toLocaleString("id-ID")}
📡 Channel  : ${raw.source_channel}
📧 Dari     : ${escapeHTML(raw.sender)}
📨 Subject  : ${escapeHTML(email.subject ?? "-")}

━━━━━━━━━━━━━━━━━━━━━
🗂 Kategori  : -
⚠️ Severity : -
🟡 Priority : -
🔄 Status   : Draft
━━━━━━━━━━━━━━━━━━━━━

🗒 <b>Summary</b>
-

📝 <b>Isi Pesan</b>
${escapeHTML((raw.body_text ?? "").slice(0, 1200))}

━━━━━━━━━━━━━━━━━━━━━

❓Apakah pesan ini merupakan tiket?
`;
}