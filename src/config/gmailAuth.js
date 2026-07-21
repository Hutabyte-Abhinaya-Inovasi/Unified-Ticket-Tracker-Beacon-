import fs from "fs";
import readline from "readline";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = "token.json";

export async function authorize() {

  const credentials = JSON.parse(
    fs.readFileSync("credentials.json")
  );

  const { client_secret, client_id, redirect_uris } =
    credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  if (fs.existsSync(TOKEN_PATH)) {

    const token = JSON.parse(
      fs.readFileSync(TOKEN_PATH)
    );

    oAuth2Client.setCredentials(token);

    return oAuth2Client;

  } else {

    return await getNewToken(oAuth2Client);

  }
}

async function getNewToken(oAuth2Client) {

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  console.log("🔑 Buka link ini di browser:");
  console.log(authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise(resolve =>
    rl.question("Masukkan kode: ", resolve)
  );

  rl.close();

  const { tokens } = await oAuth2Client.getToken(code);

  oAuth2Client.setCredentials(tokens);

  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify(tokens)
  );

  console.log("✅ Token Gmail tersimpan");

  return oAuth2Client;
}

// mengubah struktur baru !