import { authorize } from "../../config/gmailAuth.js";
import { forwardUnreadEmail } from "../../usecases/forwardUnreadEmail.js";

let gmailInterval = null;

export async function startGmailListener() {
  console.log("📧 Menghubungkan ke Gmail...");

  // Login Gmail (sekali saja)
  const auth = await authorize();

  console.log("✅ Gmail Connected");
  console.log("📬 Gmail Listener Started (cek setiap 10 detik)");

  // Cek langsung saat start
  await forwardUnreadEmail(auth);

  // Lalu cek terus setiap 10 detik
  gmailInterval = setInterval(async () => {
    try {
      console.log("📨 Checking Gmail...");

      await forwardUnreadEmail(auth);

    } catch (err) {
      console.error("❌ Gmail Listener Error:", err.message);
    }
  }, 10000);
}