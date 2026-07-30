// export async function sendEmailAcknowledgement(raw,ticketId){

//     console.log("");
//     console.log("=================================");
//     console.log("AUTO EMAIL ACK");
//     console.log("Ticket :",ticketId);
//     console.log("To :",raw.sender);
//     console.log("Message ID :",raw.source_ref);
//     console.log("=================================");
//     console.log("");

// }

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmailAcknowledgement(raw, ticketId) {
  console.log("");
  console.log("=================================");
  console.log("AUTO EMAIL ACK");
  console.log("Ticket :", ticketId);
  console.log("To :", raw.sender);
  console.log("Message ID :", raw.source_ref);
  console.log("=================================");
  console.log("");

  await transporter.sendMail({
      from: process.env.EMAIL_USER,
        to: raw.sender,
        subject: `Re: ${raw.subject || "Incident Report"}`,
        text: `Halo,

        Laporan Anda telah kami terima.

        Ticket ID: ${ticketId}

        Terima kasih.`,
  });

  console.log(raw);
}