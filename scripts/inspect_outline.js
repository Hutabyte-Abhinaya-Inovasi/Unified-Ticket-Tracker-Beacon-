import "dotenv/config";

const baseUrl = String(
  process.env.OUTLINE_BASE_URL || ""
)
  .trim()
  .replace(/\/+$/, "");

const apiKey = String(
  process.env.OUTLINE_API_KEY || ""
).trim();

if (!baseUrl) {
  console.error(
    "❌ OUTLINE_BASE_URL belum tersedia di .env"
  );
  process.exit(1);
}

if (!apiKey) {
  console.error(
    "❌ OUTLINE_API_KEY belum tersedia di .env"
  );
  process.exit(1);
}

function getArgument(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return null;
  }

  return process.argv[index + 1] || null;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

async function callOutlineApi(
  endpoint,
  payload = {}
) {
  const response = await fetch(
    `${baseUrl}/api/${endpoint}`,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },

      body: JSON.stringify(payload),
    }
  );

  const responseText =
    await response.text();

  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    result = {
      raw: responseText,
    };
  }

  if (!response.ok) {
    throw new Error(
      `${endpoint} gagal ` +
      `(${response.status}): ` +
      JSON.stringify(result)
    );
  }

  return result;
}

async function getAllCollections() {
  const collections = [];

  let offset = 0;
  const limit = 100;

  while (true) {
    const result = await callOutlineApi(
      "collections.list",
      {
        limit,
        offset,
      }
    );

    const rows = Array.isArray(result?.data)
      ? result.data
      : [];

    collections.push(...rows);

    if (rows.length < limit) {
      break;
    }

    offset += limit;
  }

  return collections;
}

async function getDocumentsByCollection(
  collectionId
) {
  const documents = [];

  let offset = 0;
  const limit = 100;

  while (true) {
    const result = await callOutlineApi(
      "documents.list",
      {
        collectionId,
        limit,
        offset,
      }
    );

    const rows = Array.isArray(result?.data)
      ? result.data
      : [];

    documents.push(...rows);

    if (rows.length < limit) {
      break;
    }

    offset += limit;
  }

  return documents;
}

async function getDocumentDetail(
  documentId
) {
  const result = await callOutlineApi(
    "documents.info",
    {
      id: documentId,
    }
  );

  return result?.data || result;
}

function printHelp() {
  console.log(`
Cara penggunaan:

1. Lihat semua collection:

   node .\\scripts\\inspect_outline.js

2. Lihat dokumen dalam satu collection:

   node .\\scripts\\inspect_outline.js --collection-id ID_COLLECTION

3. Lihat isi lengkap satu dokumen:

   node .\\scripts\\inspect_outline.js --doc-id ID_DOCUMENT

4. Cari collection berdasarkan nama:

   node .\\scripts\\inspect_outline.js --collection "Monitoring"

5. Tampilkan preview isi seluruh dokumen dalam collection:

   node .\\scripts\\inspect_outline.js --collection-id ID_COLLECTION --preview
  `);
}

async function main() {
  if (hasArgument("--help")) {
    printHelp();
    return;
  }

  const documentId =
    getArgument("--doc-id");

  const collectionIdArgument =
    getArgument("--collection-id");

  const collectionNameArgument =
    getArgument("--collection");

  const showPreview =
    hasArgument("--preview");

  /*
   * Mode 1:
   * Membuka satu dokumen lengkap.
   */
  if (documentId) {
    const document =
      await getDocumentDetail(documentId);

    console.log("\n📄 DETAIL DOKUMEN");
    console.log("==============================");
    console.log(
      "ID         :",
      document.id || documentId
    );
    console.log(
      "Judul      :",
      document.title || "(tanpa judul)"
    );
    console.log(
      "Collection :",
      document.collectionId || "-"
    );
    console.log(
      "URL        :",
      document.url
        ? `${baseUrl}${document.url}`
        : "-"
    );
    console.log(
      "Updated At :",
      document.updatedAt || "-"
    );

    console.log("\nISI DOKUMEN");
    console.log("==============================");
    console.log(
      document.text ||
      document.content ||
      "(isi dokumen kosong)"
    );

    return;
  }

  const collections =
    await getAllCollections();

  /*
   * Mode 2:
   * Hanya menampilkan collection.
   */
  if (
    !collectionIdArgument &&
    !collectionNameArgument
  ) {
    console.log(
      `\n📚 COLLECTION YANG DAPAT DIAKSES: ` +
      `${collections.length}\n`
    );

    collections.forEach(
      (collection, index) => {
        console.log(
          `${index + 1}. ${collection.name}`
        );

        console.log(
          `   ID          : ${collection.id}`
        );

        console.log(
          `   Description : ` +
          `${collection.description || "-"}`
        );

        console.log("");
      }
    );

    return;
  }

  /*
   * Menentukan collection berdasarkan ID
   * atau nama.
   */
  let selectedCollection;

  if (collectionIdArgument) {
    selectedCollection =
      collections.find(
        (collection) =>
          collection.id ===
          collectionIdArgument
      );
  } else {
    const targetName =
      collectionNameArgument
        .trim()
        .toLowerCase();

    selectedCollection =
      collections.find(
        (collection) =>
          String(collection.name || "")
            .trim()
            .toLowerCase()
            .includes(targetName)
      );
  }

  if (!selectedCollection) {
    console.error(
      "❌ Collection tidak ditemukan atau " +
      "tidak dapat diakses oleh API key."
    );

    process.exit(1);
  }

  console.log("\n📚 COLLECTION");
  console.log("==============================");
  console.log(
    "Nama :",
    selectedCollection.name
  );
  console.log(
    "ID   :",
    selectedCollection.id
  );

  const documents =
    await getDocumentsByCollection(
      selectedCollection.id
    );

  console.log(
    `\n📄 JUMLAH DOKUMEN: ${documents.length}\n`
  );

  /*
   * Mode 3:
   * Menampilkan daftar dokumen.
   */
  for (
    let index = 0;
    index < documents.length;
    index++
  ) {
    const document = documents[index];

    console.log(
      `${index + 1}. ` +
      `${document.title || "(tanpa judul)"}`
    );

    console.log(
      `   ID  : ${document.id}`
    );

    console.log(
      `   URL : ${
        document.url
          ? `${baseUrl}${document.url}`
          : "-"
      }`
    );

    console.log(
      `   Updated At: ` +
      `${document.updatedAt || "-"}`
    );

    /*
     * Preview membutuhkan documents.info
     * untuk setiap dokumen.
     */
    if (showPreview) {
      try {
        const detail =
          await getDocumentDetail(
            document.id
          );

        const text = String(
          detail.text ||
          detail.content ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();

        console.log(
          `   Preview: ${
            text
              ? `${text.slice(0, 500)}${
                  text.length > 500
                    ? "..."
                    : ""
                }`
              : "(kosong)"
          }`
        );
      } catch (error) {
        console.log(
          `   Preview gagal: ${error.message}`
        );
      }
    }

    console.log("");
  }
}

main().catch((error) => {
  console.error("\n❌ Pemeriksaan Outline gagal:");
  console.error(error.message);
  process.exit(1);
});