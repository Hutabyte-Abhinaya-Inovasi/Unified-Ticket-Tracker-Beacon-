import P from "pino";
import pkg from "@adiwajshing/baileys";
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = pkg;

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  
  // Versi WA terbaru
  const { version: waVersion } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    printQRInTerminal: true,
    version: waVersion,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    console.log("🔹 WA connection update:", update);
    if (update.connection === "open") console.log("✅ WA Connected!");
  });
}

startWA();