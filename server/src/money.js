function invalidInput(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

const MAX_AMOUNT_MINOR = 1_000_000;

export function parseAmountToMinor(value, maxMinor = MAX_AMOUNT_MINOR) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") {
    throw invalidInput("Enter an amount greater than zero.");
  }

  const raw = String(value).trim();
  const match = /^(0|[1-9]\d{0,7})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) {
    throw invalidInput("Enter a valid amount with no more than two decimal places.");
  }

  const whole = Number(match[1]);
  const fractional = Number((match[2] || "").padEnd(2, "0") || "0");
  const minor = whole * 100 + fractional;

  if (!Number.isSafeInteger(minor) || minor < 100) {
    throw invalidInput("The minimum payment is 1.00.");
  }
  if (minor > maxMinor) {
    throw invalidInput("The amount exceeds the HarborPay transaction limit.");
  }

  return minor;
}

export function minorToDecimalString(value) {
  const minor = Number(value);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw invalidInput("Invalid minor-unit amount.");
  }
  return (minor / 100).toFixed(2);
}

export function validateEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw invalidInput("Enter a valid recipient email address.");
  }
  return email;
}

export function validateDescription(value) {
  const description = String(value ?? "").trim();
  if (description.length < 3 || description.length > 120) {
    throw invalidInput("Description must contain between 3 and 120 characters.");
  }
  return description;
}
