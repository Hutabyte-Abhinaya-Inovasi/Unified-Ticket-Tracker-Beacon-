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

export function formatCandidateTicket(raw = {}) {
    let email = raw.raw_payload || {};
    if (typeof email === "string") {
        try {
            email = JSON.parse(email);
        } catch {
            email = {};
        }
    }

    const idVal = raw.id || raw.ticket_id || "-";
    const dateVal = raw.received_at || raw.processed_at || raw.created_at;
    const receivedTime = dateVal
        ? new Date(dateVal).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        })
        : "-";

    const channelVal = raw.source_channel || raw.source || "Email";
    const senderVal = raw.sender || raw.from || "-";
    const subjectVal = email.subject ?? email.group_name ?? raw.subject ?? raw.group_name ?? "(No Subject)";
    const bodyVal = raw.body_text ?? raw.body ?? "";

    return (
    `📥 <b>NEW TICKET CANDIDATE</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +

    `🆔 <b>Intake ID</b>            : <code>${escapeHTML(String(idVal))}</code>\n` +
    `🕒 <b>Received At</b>          : ${escapeHTML(receivedTime)}\n` +
    `📧 <b>Channel</b>              : ${escapeHTML(channelVal)}\n` +
    `👤 <b>Sender</b>               : ${escapeHTML(getSenderName(senderVal))}\n` +
    `📨 <b>Email</b>                : ${escapeHTML(
        email.from?.email ||
        email.from?.address ||
        (typeof senderVal === "string" ? senderVal : "-") ||
        "-"
    )}\n` +
    `🏷️ <b>Subject</b>              : ${escapeHTML(subjectVal)}\n\n` +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📋 <b>TICKET DETAILS</b>\n\n` +

    `🖥️ <b>Project</b>              : Pending Operator Confirmation\n` +
    `🗂️ <b>Category</b>             : Pending Operator Confirmation\n` +
    `⚠️ <b>Severity</b>             : Pending Operator Confirmation\n` +
    `🔄 <b>Status</b>               : Pending Confirmation\n` +
    `⏳ <b>Confirmation Deadline</b>: 15 minutes\n\n` +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📝 <b>SUMMARY</b>\n\n` +
    `Not available yet.\n\n` +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💬 <b>ORIGINAL MESSAGE</b>\n\n` +
    `${escapeHTML(String(bodyVal).slice(0, 1200))}\n\n` +

    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `❓ <b>OPERATOR DECISION</b>\n\n` +
    `Should this message be processed as a ticket?`
    );
} 