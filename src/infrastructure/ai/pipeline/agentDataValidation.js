// src/infrastructure/ai/pipeline/agentDataValidation.js

/**
 * AGENT 1 - DATA VALIDATION
 * Memastikan data tiket dan lifecycle kandidat mempunyai bentuk yang sesuai.
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
  "severity",
  "confirmed_at",
  "confirmed_by",
  "rejected_at",
  "rejected_by",
  "sla_warned",
  "sla_alerted",
  "sla_deadline_minutes",
  "escalated_at",
  "sla_confirm_warned",
  "sla_confirm_alerted",
  "intake_received_at",
  "ticket_state",
  "effective_severity",
  "confirmation_sla_state",
  "work_sla_state",
  "is_escalated",
  "needs_confirmation",
];

const VALID_TICKET_STATES = new Set([
  "confirmed",
  "pending_confirmation",
  "rejected",
  "inconsistent",
]);

function findMissingFields(row) {
  if (!row || typeof row !== "object") return EXPECTED_TICKET_FIELDS;
  return EXPECTED_TICKET_FIELDS.filter((field) => row[field] === undefined);
}

function validateLifecycle(row, issues, prefix = "") {
  if (!VALID_TICKET_STATES.has(row.ticket_state)) {
    issues.push(`${prefix}ticket_state tidak valid: ${row.ticket_state}`);
  }

  if (row.ticket_state === "confirmed") {
    if (!row.confirmed_at) {
      issues.push(`${prefix}ticket_state confirmed tetapi confirmed_at kosong`);
    }
    if (row.rejected_at) {
      issues.push(`${prefix}ticket_state confirmed tetapi rejected_at terisi`);
    }
  }

  if (
    row.ticket_state === "pending_confirmation" &&
    (row.confirmed_at || row.rejected_at)
  ) {
    issues.push(
      `${prefix}pending_confirmation tetapi confirmed_at atau rejected_at sudah terisi`
    );
  }

  if (row.ticket_state === "rejected" && !row.rejected_at) {
    issues.push(`${prefix}ticket_state rejected tetapi rejected_at kosong`);
  }

  if (row.confirmed_at && row.rejected_at) {
    issues.push(`${prefix}confirmed_at dan rejected_at sama-sama terisi`);
  }
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
          issues.push("Tiket tidak ditemukan");
        } else {
          const missing = findMissingFields(rawResult);
          if (missing.length > 0) {
            issues.push(`Field tidak lengkap: ${missing.join(", ")}`);
          }
          validateLifecycle(rawResult, issues);
        }
      }
      break;
    }

    case "query_tickets": {
      if (!isError) {
        if (!Array.isArray(rawResult.tickets)) {
          issues.push("Field tickets bukan array");
        } else if (rawResult.tickets.length === 0) {
          isEmpty = true;
        } else {
          const missingSet = new Set();

          rawResult.tickets.forEach((row, index) => {
            findMissingFields(row).forEach((field) => missingSet.add(field));
            validateLifecycle(row, issues, `Baris ${index + 1}: `);
          });

          if (missingSet.size > 0) {
            issues.push(
              `Sebagian baris mempunyai field tidak lengkap: ${[
                ...missingSet,
              ].join(", ")}`
            );
          }
        }

        if (typeof rawResult.count !== "number") {
          issues.push("Field count tidak tersedia");
        }

        if (
          !rawResult.filters_applied ||
          typeof rawResult.filters_applied !== "object"
        ) {
          issues.push("filters_applied tidak tersedia");
        }
      }
      break;
    }

    default:
      issues.push(`Tool tidak dikenal: ${toolName}`);
  }

  return {
    agent: "data_validation",
    valid: !isError && issues.length === 0,
    isEmpty,
    isError,
    issues,
  };
}
