export function parseMoneyAmount(value) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw new Error("Enter an amount greater than zero.");
  }
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error("Enter a valid positive amount with no more than two decimal places.");
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter an amount greater than zero.");
  if (amount > 1000000) throw new Error("Amount exceeds the local demo limit.");
  return Math.round(amount * 100) / 100;
}

export function validateRecipient(value) {
  const recipient = String(value ?? "").trim();
  if (recipient.length < 3 || recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error("Enter a valid recipient email address.");
  }
  return recipient.toLowerCase();
}
