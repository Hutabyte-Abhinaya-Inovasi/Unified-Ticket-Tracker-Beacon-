import fetch from "node-fetch";
import { env } from "../../config/env.js";

export async function createClickUpTask(ticket) {
  if (!env.CLICKUP_API_KEY || !env.CLICKUP_LIST_ID) {
    console.warn(
      "⚠️ ClickUp integration dinonaktifkan: CLICKUP_API_KEY / CLICKUP_LIST_ID belum diisi."
    );
    return null;
  }

  try {
    console.log("📤 Mengirim ke ClickUp...");
    console.log(ticket);

    const response = await fetch(
      `https://api.clickup.com/api/v2/list/${env.CLICKUP_LIST_ID}/task`,
      {
        method: "POST",
        headers: {
          Authorization: env.CLICKUP_API_KEY,
          "Content-Type": "application/json",
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
`,
        }),
      }
    );

    const data = await response.json();

    console.log("Status HTTP :", response.status);
    console.log("Response :", data);

    if (!response.ok) {
      console.error("❌ ClickUp Error");
      return null;
    }

    console.log("✅ ClickUp Task berhasil dibuat");
    return data.url || data.id;

  } catch (err) {
    console.error("❌ Gagal kirim ke ClickUp");
    console.error(err);
    return null;
  }
}

// Backward compatibility
export const pushTicketToClickUp = createClickUpTask;