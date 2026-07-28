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
    const receivedTime = raw.received_at
        ? new Date(raw.received_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
        : "-";

    return (
        `📥 <b>KANDIDAT TIKET BARU</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🆔 Intake ID   : <code>${escapeHTML(String(raw.id || "-"))}</code>\n` +
        `📅 Diterima    : ${escapeHTML(receivedTime)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `📡 Channel     : ${escapeHTML(raw.source_channel || "Email")}\n` +
        `👤 Dari        : ${escapeHTML(getSenderName(raw.sender))}\n` +
        `📌 Subject     : ${escapeHTML(email.subject ?? "-")}\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🗂 Kategori    : Belum diisi\n` +
        `⚠️ Severity    : Belum diisi\n` +
        `📋 Status      : Menunggu Konfirmasi (SLA: 15 Menit)\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🗒 Ringkasan: -\n\n` +
        `💬 <b>Pesan Asli:</b>\n` +
        `${escapeHTML((raw.body_text ?? "").slice(0, 1200))}\n\n` +
        `<i>Apakah pesan ini merupakan tiket?</i>`
    );
}