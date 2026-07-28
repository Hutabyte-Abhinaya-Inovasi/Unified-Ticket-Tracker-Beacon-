function escapeHTML(text = "") {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function getSenderName(sender) {
    if (!sender) return "-";

    // Kalau sudah string
    if (typeof sender === "string") {
        return sender;
    }

    // Format object dari mailparser
    if (sender.text) {
        return sender.text;
    }

    // Format AddressObject mailparser
    if (sender.value?.length) {
        const person = sender.value[0];

        if (person.name && person.address) {
            return `${person.name} <${person.address}>`;
        }

        return person.name || person.address || "-";
    }

    return "-";
}

export function formatCandidateTicket(raw) {

    const email = raw.raw_payload || {};

    return `
📥 <b>KANDIDAT TIKET BARU</b>

📅 Diterima : ${new Date(raw.received_at).toLocaleString("id-ID")}
📡 Channel  : ${raw.source_channel}
📧 Dari     : ${escapeHTML(getSenderName(raw.sender))}
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