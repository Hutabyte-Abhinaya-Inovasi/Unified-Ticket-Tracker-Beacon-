import fetch from "node-fetch";

const TOKEN = process.env.CLICKUP_TOKEN;
const LIST_ID = process.env.CLICKUP_LIST_ID;

export async function createClickUpTask(ticket) {
    try {

        console.log("📤 Mengirim ke ClickUp...");
        console.log(ticket);

        const response = await fetch(
            `https://api.clickup.com/api/v2/list/${LIST_ID}/task`,
            {
                method: "POST",
                headers: {
                    Authorization: TOKEN,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    name: `${ticket.ticket_id} - ${ticket.subject || ticket.summary || "No Subject"}`,
                    description: `
Ticket ID : ${ticket.ticket_id}

From : ${ticket.from}

Source : ${ticket.source}

Priority : ${ticket.priority}

Body :

${ticket.body}
`
                })
            }
        );

        const data = await response.json();

        console.log("Status HTTP :", response.status);
        console.log("Response :", data);

        if (!response.ok) {
            console.error("❌ ClickUp Error");
            return;
        }

        console.log("✅ ClickUp Task berhasil dibuat");

    } catch (err) {

        console.error("❌ Gagal kirim ke ClickUp");
        console.error(err);

    }
}