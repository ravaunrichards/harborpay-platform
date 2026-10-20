import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

const app = express();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.WEB_ORIGIN || "http://localhost:5173").split(",").map(s => s.trim());
app.use(helmet());
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin is not allowed by CORS"));
} }));
app.use(express.json({ limit: "20kb" }));

// No synthetic balances or transaction records are returned as account data.
const transactions = [];

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "harborpay-api", mode: "local-demo" }));
app.get("/api/wallet", (_req, res) => res.json({
  mode: "local-demo",
  notice: "No authenticated account or live financial data is connected.",
  currency: "USD", availableBalance: null, pendingBalance: null,
  transactions
}));
app.get("/api/transactions", (_req, res) => res.json({ mode: "local-demo", items: transactions }));
app.post("/api/validate-payment-draft", async (req, res) => {
  try {
    const { parseMoneyAmount, validateRecipient } = await import("./validation.js");
    const amount = parseMoneyAmount(req.body?.amount);
    const recipient = validateRecipient(req.body?.recipient);
    res.json({ valid: true, draft: { amount, recipient, currency: "USD" }, note: "Validated draft only; no payment was sent." });
  } catch (error) {
    res.status(400).json({ valid: false, error: error.message || "Invalid draft." });
  }
});
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
app.listen(port, () => console.log(`HarborPay API listening on http://localhost:${port}`));
