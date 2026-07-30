import { sendEmailAcknowledgement } from "../email/emailReplyService.js";

export async function sendAcknowledgement(raw, ticketId){

    try{

        switch(raw.source_channel){

            case "email":

                await sendEmailAcknowledgement(raw,ticketId);

                break;

            default:

                console.log(
                    `ACK belum tersedia untuk ${raw.source_channel}`
                );

        }

    }catch(err){

        console.error("ACK ERROR :",err.message);

    }

}