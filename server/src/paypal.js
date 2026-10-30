let cachedAccessToken = null;
let tokenExpiresAt = 0;

function getPayPalBaseUrl() {
  const environment = (process.env.PAYPAL_ENVIRONMENT || "sandbox").toLowerCase();
  if (environment === "live") return "https://api-m.paypal.com";
  if (environment === "sandbox") return "https://api-m.sandbox.paypal.com";
  throw new Error("PAYPAL_ENVIRONMENT must be sandbox or live.");
}

export function isPayPalConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

export function isPayPalWebhookConfigured() {
  return Boolean(isPayPalConfigured() && process.env.PAYPAL_WEBHOOK_ID);
}

async function getAccessToken() {
  if (!isPayPalConfigured()) {
    const error = new Error("PayPal server credentials are not configured.");
    error.status = 503;
    throw error;
  }

  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const credentials = Buffer.from(
    process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_CLIENT_SECRET
  ).toString("base64");

  const response = await fetch(getPayPalBaseUrl() + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + credentials,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: "grant_type=client_credentials"
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error("PayPal authorization failed. Check the server-side API credentials and environment.");
    error.status = 502;
    throw error;
  }

  cachedAccessToken = payload.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in || 300)) * 1000;
  return cachedAccessToken;
}

async function paypalRequest(method, path, body, requestId) {
  const token = await getAccessToken();
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  if (requestId) headers["PayPal-Request-Id"] = requestId;

  const response = await fetch(getPayPalBaseUrl() + path, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("PayPal request failed with HTTP " + response.status + ".");
    error.status = 502;
    error.providerStatus = response.status;
    error.providerIssue = payload.name || payload.error || "PAYPAL_REQUEST_FAILED";
    throw error;
  }

  return payload;
}

export async function createPayPalOrder({
  paymentId,
  amount,
  currency,
  description,
  returnUrl,
  cancelUrl
}) {
  return paypalRequest(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: paymentId,
        custom_id: paymentId,
        description,
        amount: {
          currency_code: currency,
          value: amount
        }
      }],
      application_context: {
        brand_name: "HarborPay",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: returnUrl,
        cancel_url: cancelUrl
      }
    },
    paymentId
  );
}

export async function capturePayPalOrder(orderId, paymentId) {
  return paypalRequest(
    "POST",
    "/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture",
    {},
    paymentId.replaceAll("-", "") + "C"
  );
}

export async function createPayPalPayout({
  payoutId,
  senderBatchId,
  senderItemId,
  recipientEmail,
  amount,
  currency
}) {
  return paypalRequest(
    "POST",
    "/v1/payments/payouts",
    {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: "You have a payment from HarborPay",
        email_message: "A payment has been sent to your PayPal account."
      },
      items: [{
        recipient_type: "EMAIL",
        receiver: recipientEmail,
        amount: {
          value: amount,
          currency
        },
        note: "HarborPay merchant disbursement",
        sender_item_id: senderItemId
      }]
    },
    payoutId
  );
}

export async function verifyPayPalWebhook(headers, event, rawEventJson) {
  if (!isPayPalWebhookConfigured()) {
    const error = new Error("PayPal webhook verification is not configured.");
    error.status = 503;
    throw error;
  }

  const requiredHeaders = [
    "paypal-auth-algo",
    "paypal-cert-url",
    "paypal-transmission-id",
    "paypal-transmission-sig",
    "paypal-transmission-time"
  ];
  if (requiredHeaders.some((name) => !headers[name])) return false;

  if (typeof rawEventJson !== "string" || !rawEventJson.trim()) {
    const error = new Error("The original PayPal webhook body is required for signature verification.");
    error.status = 400;
    throw error;
  }

  const verificationBody =
    `{"auth_algo":${JSON.stringify(headers["paypal-auth-algo"])},` +
    `"cert_url":${JSON.stringify(headers["paypal-cert-url"])},` +
    `"transmission_id":${JSON.stringify(headers["paypal-transmission-id"])},` +
    `"transmission_sig":${JSON.stringify(headers["paypal-transmission-sig"])},` +
    `"transmission_time":${JSON.stringify(headers["paypal-transmission-time"])},` +
    `"webhook_id":${JSON.stringify(process.env.PAYPAL_WEBHOOK_ID)},` +
    `"webhook_event":${rawEventJson}}`;

  const verification = await paypalRequest(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    verificationBody
  );

  return verification.verification_status === "SUCCESS";
}
