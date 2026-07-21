// RULE BASED CLASSIFIER (HEMAT BIAYA AI)

const RULES = [
  {
    name: "INCIDENT",
    keywords: ["down", "error", "failed", "cannot", "timeout", "refused"],
    category: "Incident Management",
    priority: "HIGH",
  },
  {
    name: "CRITICAL INCIDENT",
    keywords: ["server down", "production down", "service unavailable"],
    category: "Incident Management",
    priority: "CRITICAL",
  },
  {
    name: "REQUEST",
    keywords: ["request", "please", "mohon", "bisa bantu"],
    category: "Service Request Management",
    priority: "MEDIUM",
  },
  {
    name: "CHANGE",
    keywords: ["deploy", "deployment", "upgrade", "migration"],
    category: "Change Management",
    priority: "MEDIUM",
  },
  {
    name: "REPORT",
    keywords: ["daily report", "report", "summary"],
    category: "Knowledge Management",
    priority: "LOW",
    skipAI: true, // 🔥 langsung skip AI
  },
];

/**
 * 🔥 RULE ENGINE
 */
export function classifyByRule(email) {
  const text = `${email.subject} ${email.body}`.toLowerCase();

  for (const rule of RULES) {
    if (rule.keywords.some((k) => text.includes(k))) {
      return {
        category: rule.category,
        priority: rule.priority,
        summary: email.subject,
        useAI: !rule.skipAI,
        matchedRule: rule.name,
      };
    }
  }

  // tidak kena rule → pakai AI
  return {
    useAI: true,
  };
}

// tidak penting dengan update V1, untuk sekarang masih jalan di n8n 