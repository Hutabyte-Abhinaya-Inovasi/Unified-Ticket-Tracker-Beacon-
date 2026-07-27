// Jalankan: node scripts/test_outline_api.js "kata kunci"
import "dotenv/config";
import {
  getOutlineDocument,
  searchOutlineDocuments,
} from "../src/infrastructure/outline/outlineClient.js";

const query = process.argv.slice(2).join(" ").trim() || "test";

try {
  const search = await searchOutlineDocuments(query, { limit: 1 });
  const items = Array.isArray(search?.data) ? search.data : [];
  const first = items[0]?.document || items[0];

  console.log({
    ok: true,
    query,
    search_count: items.length,
    first_id: first?.id || null,
    first_title: first?.title || null,
  });

  if (first?.id) {
    const detail = await getOutlineDocument(first.id);
    const document = detail?.data || detail;

    console.log({
      detail_ok: true,
      title: document?.title || null,
      content_length: String(document?.text || document?.content || "").length,
      url: document?.url || null,
    });
  }
} catch (error) {
  console.error({
    ok: false,
    status: error.status || null,
    message: error.message,
  });
  process.exitCode = 1;
}
