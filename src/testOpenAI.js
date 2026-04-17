import { analyzeEmail } from "./infrastructure/ai/openaiService.js";

const email = {
  from: "test@email.com",
  subject: "Payment gateway error",
  body: "Customers cannot complete payment. Error code 502."
};

const result = await analyzeEmail(email);

console.log(result);