// src/infrastructure/ai/pipeline/agentDataValidation.js
/**
 * AGENT 1 — DATA VALIDATION
 * - Memastikan data yang diambil dari Supabase sesuai bentuk yang diharapkan per tool.
 */

const EXPECTED_TICKET_FIELDS = [
  "ticket_id",
  "subject",
  "body",
  "summary",
  "category",
  "assignee",
  "status",
  "processed_at",
  "action_needed",
  "source",
  "priority",
];

function findMissingFields(row) {
  if (!row || typeof row !== "object") return EXPECTED_TICKET_FIELDS;
  return EXPECTED_TICKET_FIELDS.filter((f) => row[f] === undefined);
}

export function runDataValidation(toolName, args, rawResult) {
  const issues = [];
  let isEmpty = false;
  let isError = false;

  if (!rawResult || typeof rawResult !== "object") {
    return {
      agent: "data_validation",
      valid: false,
      isEmpty: false,
      isError: true,
      issues: ["Hasil tool kosong atau bukan object yang valid"],
    };
  }

  if (rawResult.error) {
    isError = true;
    issues.push(`Tool mengembalikan error: ${rawResult.error}`);
  }

  switch (toolName) {
    case "get_ticket_detail": {
      if (!isError) {
        if (!rawResult.ticket_id) {
          isEmpty = true;
          issues.push("Tiket tidak ditemukan (ticket_id kosong pada hasil)");
        } else {
          const missing = findMissingFields(rawResult);
          if (missing.length > 0) issues.push(`Field tidak lengkap pada tiket: ${missing.join(", ")}`);
        }
      }
      break;
    }

    case "query_tickets": {
      if (!isError) {
        if (!Array.isArray(rawResult.tickets)) {
          issues.push("Field 'tickets' pada hasil tidak berupa array");
        } else if (rawResult.tickets.length === 0) {
          isEmpty = true;
        } else {
          const missingSet = new Set();
          rawResult.tickets.forEach((row) => {
            findMissingFields(row).forEach((f) => missingSet.add(f));
          });
          if (missingSet.size > 0) {
            issues.push(`Sebagian baris punya field tidak lengkap: ${[...missingSet].join(", ")}`);
          }
        }
        if (typeof rawResult.count !== "number") {
          issues.push("Field 'count' (jumlah pasti) tidak tersedia pada hasil");
        }
      }
      break;
    }

    // update_ticket & delete_ticket sengaja tidak ada case-nya di sini —
    // tool tersebut sudah dihapus total dari daftar tools AI (lihat openaiService.js).
    // get_ticket_detail & query_tickets.

    default: {
      issues.push(`Tool tidak dikenal oleh Data Validation Agent: ${toolName}`);
    }
  }

  return {
    agent: "data_validation",
    valid: !isError && issues.length === 0,
    isEmpty,
    isError,
    issues,
  };
}