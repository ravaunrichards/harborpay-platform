function invalidInput(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function validateMerchantName(value) {
  const name = String(value ?? "").trim();
  if (name.length < 2 || name.length > 120) {
    throw invalidInput("Merchant name must contain between 2 and 120 characters.");
  }
  return name;
}

export function validateOrderReference(value) {
  const reference = String(value ?? "").trim();
  if (reference.length < 2 || reference.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(reference)) {
    throw invalidInput("Order reference must be 2–80 characters and use letters, numbers, dots, underscores, colons or hyphens.");
  }
  return reference;
}

export function validatePaymentLinkTitle(value) {
  const title = String(value ?? "").trim();
  if (title.length < 2 || title.length > 120) {
    throw invalidInput("Payment link title must contain between 2 and 120 characters.");
  }
  return title;
}

export function validateOptionalUrl(value) {
  if (value == null || String(value).trim() === "") return null;
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw invalidInput("Enter a valid HTTPS website URL.");
  }
  if (parsed.protocol !== "https:") throw invalidInput("Website URL must use HTTPS.");
  return parsed.toString();
}
