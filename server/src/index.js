import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import {
  capturePayPalOrder,
  createPayPalOrder,
  createPayPalPayout,
  isPayPalConfigured,
  isPayPalWebhookConfigured,
  verifyPayPalWebhook
} from "./paypal.js";
import {
  minorToDecimalString,
  parseAmountToMinor,
  validateDescription,
  validateEmail
} from "./money.js";
import {
  validateMerchantName,
  validateOrderReference,
  validatePaymentLinkTitle,
  validateOptionalUrl
} from "./merchant.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = new Set(
  (process.env.WEB_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
let supabaseAdmin = null;

app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"]
}));

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function getIdempotencyKey(request) {
  const value = String(request.get("Idempotency-Key") || "").trim();
  if (value.length < 16 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw httpError(400, "A valid Idempotency-Key header is required.");
  }
  return value;
}

function getDatabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw httpError(503, "HarborPay database and authentication are not configured.");
  }

  if (!supabaseAdmin) {
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false
        }
      }
    );
  }

  return supabaseAdmin;
}

const requireAuth = asyncRoute(async (request, response, next) => {
  const authorization = request.headers.authorization || "";
  const tokenMatch = /^Bearer\s+(.+)$/i.exec(authorization);

  if (!tokenMatch) throw httpError(401, "Sign in to continue.");

  const { data, error } = await getDatabase().auth.getUser(tokenMatch[1]);
  if (error || !data?.user) throw httpError(401, "Your session is invalid or expired.");

  request.user = data.user;
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (request) => request.path === "/health"
});

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "harborpay-api",
    configured: {
      supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      paypal: isPayPalConfigured(),
      paypalWebhook: isPayPalWebhookConfigured(),
      payoutsEnabled: process.env.PAYPAL_PAYOUTS_ENABLED === "true"
    },
    timestamp: new Date().toISOString()
  });
});

async function processPayPalEvent(database, event) {
  const resource = event.resource || {};
  const eventType = event.event_type;

  if (eventType === "CHECKOUT.ORDER.APPROVED") {
    if (resource.id) {
      const paymentId = resource.purchase_units?.[0]?.custom_id;
      if (paymentId) {
        const { error: linkError } = await database.from("payments")
          .update({ provider_order_id: resource.id, status: "approved" })
          .eq("id", paymentId)
          .eq("status", "created");
        if (linkError) throw httpError(503, "Approved PayPal order could not be linked to its payment record.");
      }

      const { error: updateError } = await database.from("payments")
        .update({ status: "approved" })
        .eq("provider_order_id", resource.id)
        .eq("status", "created");
      if (updateError) throw httpError(503, "Approved PayPal order status could not be reconciled.");
    }
    return;
  }

  const captureEvents = new Set([
    "PAYMENT.CAPTURE.COMPLETED",
    "PAYMENT.CAPTURE.PENDING",
    "PAYMENT.CAPTURE.DENIED",
    "PAYMENT.CAPTURE.REFUNDED"
  ]);

  if (captureEvents.has(eventType)) {
    const orderId = resource.supplementary_data?.related_ids?.order_id;
    if (!orderId) return;

    const { data: payment, error: lookupError } = await database.from("payments")
      .select("id, amount_minor, currency, status")
      .eq("provider_order_id", orderId)
      .maybeSingle();

    if (lookupError) throw httpError(503, "Payment reconciliation lookup failed.");
    if (!payment) return;
    if (payment.status === "refunded" || payment.status === "review_required") return;

    const providerAmountMinor = Math.round(Number(resource.amount?.value) * 100);
    const amountMatches = Number.isSafeInteger(providerAmountMinor) &&
      providerAmountMinor === Number(payment.amount_minor) &&
      resource.amount?.currency_code === payment.currency;

    let nextStatus = "review_required";
    if (amountMatches) {
      if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
        nextStatus = ["created", "approved", "pending"].includes(payment.status)
          ? "completed"
          : "review_required";
      } else if (eventType === "PAYMENT.CAPTURE.PENDING") {
        nextStatus = ["created", "approved", "pending"].includes(payment.status)
          ? "pending"
          : "review_required";
      } else if (eventType === "PAYMENT.CAPTURE.DENIED") {
        nextStatus = ["created", "approved", "pending"].includes(payment.status)
          ? "failed"
          : "review_required";
      } else if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
        nextStatus = payment.status === "completed" ? "refunded" : "review_required";
      }
    }

    const { error: updateError } = await database.from("payments")
      .update({
        status: nextStatus,
        provider_capture_id: resource.id || null
      })
      .eq("id", payment.id);

    if (updateError) throw httpError(503, "Payment event could not be reconciled.");
    return;
  }

  if (eventType.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const senderItemId = resource.payout_item?.sender_item_id || resource.sender_item_id;
    if (!senderItemId) return;

    let payoutStatus;
    if (eventType === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") payoutStatus = "succeeded";
    else if (eventType === "PAYMENT.PAYOUTS-ITEM.FAILED") payoutStatus = "failed";
    else payoutStatus = "requires_review";

    const { error } = await database.from("payouts")
      .update({
        status: payoutStatus,
        provider_item_id: resource.payout_item_id || resource.payout_item?.payout_item_id || null
      })
      .eq("provider_sender_item_id", senderItemId);

    if (error) throw httpError(503, "Payout event could not be reconciled.");
  }
}

app.post("/api/paypal/webhook", express.raw({ type: "application/json", limit: "256kb" }), asyncRoute(async (request, response) => {
  if (!Buffer.isBuffer(request.body)) throw httpError(400, "Invalid webhook body.");

  const rawEventJson = request.body.toString("utf8");
  let event;
  try {
    event = JSON.parse(rawEventJson);
  } catch {
    throw httpError(400, "Webhook body is not valid JSON.");
  }

  if (!event.id || !event.event_type) throw httpError(400, "Webhook event is missing required identifiers.");

  const verified = await verifyPayPalWebhook(request.headers, event, rawEventJson);
  if (!verified) throw httpError(400, "PayPal webhook signature verification failed.");

  const database = getDatabase();
  const workerId = randomUUID();
  const { data: claimState, error: claimError } = await database.rpc(
    "harborpay_claim_webhook_event",
    {
      p_provider_event_id: event.id,
      p_event_type: event.event_type,
      p_payload: event,
      p_worker_id: workerId
    }
  );

  if (claimError) {
    throw httpError(503, "Verified webhook could not be claimed for processing. PayPal may retry delivery.");
  }
  if (claimState === "processed") {
    return response.status(200).json({ received: true, duplicate: true });
  }
  if (claimState !== "claimed") {
    throw httpError(503, "This webhook is already being processed. PayPal should retry delivery.");
  }

  try {
    await processPayPalEvent(database, event);
    const { data: completed, error: completionError } = await database.rpc(
      "harborpay_complete_webhook_event",
      {
        p_provider_event_id: event.id,
        p_worker_id: workerId
      }
    );

    if (completionError || completed !== true) {
      throw httpError(503, "Webhook was processed but its completion marker could not be saved.");
    }
  } catch (error) {
    await database.rpc("harborpay_release_webhook_event", {
      p_provider_event_id: event.id,
      p_worker_id: workerId,
      p_error: String(error?.message || "Unknown processing error").slice(0, 1000)
    });
    throw error;
  }

  response.status(200).json({ received: true });
}));

app.use(express.json({ limit: "32kb" }));
app.use("/api", apiLimiter);

app.get("/api/payments", requireAuth, asyncRoute(async (request, response) => {
  const { data, error } = await getDatabase().from("payments")
    .select("id, amount_minor, currency, description, status, provider_order_id, provider_capture_id, created_at")
    .eq("user_id", request.user.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw httpError(503, "Payment history is temporarily unavailable.");
  response.json({ items: data || [] });
}));

app.post("/api/payments/orders", requireAuth, asyncRoute(async (request, response) => {
  if (!isPayPalConfigured()) throw httpError(503, "PayPal checkout is not configured on the server.");

  const currency = (process.env.PAYPAL_CURRENCY || "USD").toUpperCase();
  if (currency !== "USD") throw httpError(503, "This HarborPay release is configured for USD checkout only.");

  const idempotencyKey = getIdempotencyKey(request);
  const amountMinor = parseAmountToMinor(request.body?.amount);
  const amount = minorToDecimalString(amountMinor);
  const description = validateDescription(request.body?.description);
  const appUrl = process.env.APP_URL;

  if (!appUrl) throw httpError(503, "HarborPay return and cancel URLs are not configured.");

  let appOrigin;
  try {
    appOrigin = new URL(appUrl).origin;
  } catch {
    throw httpError(503, "APP_URL must be a valid absolute URL.");
  }

  const database = getDatabase();
  const { data: existing, error: existingError } = await database.from("payments")
    .select("id, status")
    .eq("user_id", request.user.id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingError) throw httpError(503, "The existing payment attempt could not be checked.");
  if (existing) throw httpError(409, "This payment attempt has already been submitted. Refresh your transaction history before starting another payment.");

  const { data: payment, error: insertError } = await database.from("payments")
    .insert({
      user_id: request.user.id,
      idempotency_key: idempotencyKey,
      amount_minor: amountMinor,
      currency,
      description,
      status: "created"
    })
    .select("id")
    .single();

  if (insertError || !payment) {
    if (insertError?.code === "23505") throw httpError(409, "This payment attempt has already been submitted.");
    throw httpError(503, "The payment could not be recorded.");
  }

  let providerOrder;
  try {
    providerOrder = await createPayPalOrder({
      paymentId: payment.id,
      amount,
      currency,
      description,
      returnUrl: appOrigin + "/?payment=return",
      cancelUrl: appOrigin + "/?payment=cancelled"
    });
  } catch (error) {
    await database.from("payments")
      .update({ status: "review_required" })
      .eq("id", payment.id)
      .eq("user_id", request.user.id);
    throw error;
  }

  const approvalUrl = (providerOrder.links || []).find((link) =>
    link.rel === "approve" || link.rel === "payer-action"
  )?.href;

  if (!providerOrder.id || !approvalUrl) {
    await database.from("payments")
      .update({ status: "review_required" })
      .eq("id", payment.id)
      .eq("user_id", request.user.id);
    throw httpError(502, "PayPal did not return a valid approval URL. The payment has not been reported as successful.");
  }

  const { error: updateError } = await database.from("payments")
    .update({ provider_order_id: providerOrder.id })
    .eq("id", payment.id)
    .eq("user_id", request.user.id);

  if (updateError) throw httpError(503, "The provider order could not be linked to HarborPay. Contact support before retrying.");

  response.status(201).json({
    paymentId: payment.id,
    orderId: providerOrder.id,
    approvalUrl,
    status: "created"
  });
}));

app.post("/api/payments/capture", requireAuth, asyncRoute(async (request, response) => {
  const orderId = String(request.body?.orderId || "").trim();
  if (!orderId || orderId.length > 128) throw httpError(400, "A valid PayPal order ID is required.");

  const database = getDatabase();
  const { data: payment, error: lookupError } = await database.from("payments")
    .select("id, amount_minor, currency, status, provider_order_id")
    .eq("provider_order_id", orderId)
    .eq("user_id", request.user.id)
    .maybeSingle();

  if (lookupError) throw httpError(503, "The payment record could not be loaded.");
  if (!payment) throw httpError(404, "No payment for this PayPal order belongs to your account.");
  if (payment.status === "completed") {
    return response.json({ payment, alreadyCompleted: true });
  }
  if (["failed", "cancelled", "refunded", "review_required"].includes(payment.status)) {
    throw httpError(409, "This payment cannot be captured in its current state.");
  }

  const providerOrder = await capturePayPalOrder(orderId, payment.id);
  const capture = providerOrder.purchase_units?.[0]?.payments?.captures?.[0];

  if (!capture) throw httpError(502, "PayPal did not return a capture record. Check the PayPal activity before retrying.");

  const providerAmountMinor = Math.round(Number(capture.amount?.value) * 100);
  const amountMatches = Number.isSafeInteger(providerAmountMinor) &&
    providerAmountMinor === Number(payment.amount_minor) &&
    capture.amount?.currency_code === payment.currency;

  let nextStatus = "pending";
  if (!amountMatches) nextStatus = "review_required";
  else if (capture.status === "COMPLETED") nextStatus = "completed";
  else if (capture.status === "DENIED") nextStatus = "failed";
  else if (capture.status === "PENDING") nextStatus = "pending";

  const { data: updated, error: updateError } = await database.from("payments")
    .update({
      status: nextStatus,
      provider_capture_id: capture.id || null
    })
    .eq("id", payment.id)
    .eq("user_id", request.user.id)
    .select("id, amount_minor, currency, description, status, provider_order_id, provider_capture_id, created_at")
    .single();

  if (updateError || !updated) throw httpError(503, "PayPal responded, but the payment record could not be reconciled.");

  response.json({
    payment: updated,
    providerStatus: capture.status,
    amountMatches
  });
}));

app.post("/api/payments/cancel", requireAuth, asyncRoute(async (request, response) => {
  const orderId = String(request.body?.orderId || "").trim();
  if (!orderId) throw httpError(400, "A PayPal order ID is required.");

  const { data, error } = await getDatabase().from("payments")
    .update({ status: "cancelled" })
    .eq("provider_order_id", orderId)
    .eq("user_id", request.user.id)
    .in("status", ["created", "approved"])
    .select("id, status")
    .maybeSingle();

  if (error) throw httpError(503, "The payment cancellation could not be recorded.");
  response.json({ payment: data || null });
}));


function validateUuid(value, label) {
  const candidate = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    throw httpError(400, "A valid " + label + " is required.");
  }
  return candidate;
}

async function requireMerchantRole(database, merchantId, userId, allowedRoles) {
  validateUuid(merchantId, "merchant ID");
  const { data, error } = await database.from("merchant_members")
    .select("role")
    .eq("merchant_id", merchantId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw httpError(503, "Merchant permissions could not be checked.");
  if (!data || !allowedRoles.includes(data.role)) {
    throw httpError(403, "You do not have permission to access this merchant resource.");
  }
  return data.role;
}

app.get("/api/merchants", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  const { data: memberships, error: membershipError } = await database.from("merchant_members")
    .select("merchant_id, role")
    .eq("user_id", request.user.id);

  if (membershipError) throw httpError(503, "Merchant accounts could not be loaded.");
  if (!memberships?.length) return response.json({ items: [] });

  const ids = memberships.map((item) => item.merchant_id);
  const { data: merchants, error } = await database.from("merchant_accounts")
    .select("id, display_name, legal_name, country_code, settlement_currency, business_email, website_url, status, payouts_enabled, created_at")
    .in("id", ids)
    .order("created_at", { ascending: false });

  if (error) throw httpError(503, "Merchant accounts could not be loaded.");
  const roles = new Map(memberships.map((item) => [item.merchant_id, item.role]));
  response.json({ items: (merchants || []).map((merchant) => ({ ...merchant, role: roles.get(merchant.id) })) });
}));

app.post("/api/merchants", requireAuth, asyncRoute(async (request, response) => {
  const displayName = validateMerchantName(request.body?.displayName);
  const businessEmail = request.body?.businessEmail ? validateEmail(request.body.businessEmail) : null;
  const websiteUrl = validateOptionalUrl(request.body?.websiteUrl);
  const { data, error } = await getDatabase().from("merchant_accounts")
    .insert({
      owner_user_id: request.user.id,
      display_name: displayName,
      business_email: businessEmail,
      website_url: websiteUrl,
      country_code: "JM",
      settlement_currency: "USD",
      status: "draft"
    })
    .select("id, display_name, status, country_code, settlement_currency, created_at")
    .single();

  if (error || !data) throw httpError(503, "Merchant account could not be created.");
  response.status(201).json({ merchant: { ...data, role: "owner" } });
}));

app.get("/api/merchants/:merchantId/customers", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  await requireMerchantRole(database, request.params.merchantId, request.user.id, ["owner", "admin", "finance", "support"]);
  const { data, error } = await database.from("merchant_customers")
    .select("id, email, full_name, phone_e164, country_code, external_reference, created_at")
    .eq("merchant_id", request.params.merchantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw httpError(503, "Merchant customers could not be loaded.");
  response.json({ items: data || [] });
}));

app.post("/api/merchants/:merchantId/customers", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  await requireMerchantRole(database, request.params.merchantId, request.user.id, ["owner", "admin", "finance", "support"]);
  const email = validateEmail(request.body?.email);
  const fullName = request.body?.fullName == null ? null : String(request.body.fullName).trim().slice(0, 120);
  const phoneE164 = request.body?.phoneE164 == null || request.body.phoneE164 === ""
    ? null
    : String(request.body.phoneE164).trim();
  if (phoneE164 && !/^\\+[1-9]\\d{7,14}$/.test(phoneE164)) {
    throw httpError(400, "Phone number must use international E.164 format.");
  }
  const countryCode = request.body?.countryCode == null || request.body.countryCode === ""
    ? null
    : String(request.body.countryCode).trim().toUpperCase();
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
    throw httpError(400, "Country code must be a two-letter ISO code.");
  }
  const externalReference = request.body?.externalReference == null || request.body.externalReference === ""
    ? null
    : String(request.body.externalReference).trim().slice(0, 120);
  const { data, error } = await database.from("merchant_customers")
    .insert({
      merchant_id: request.params.merchantId,
      email,
      full_name: fullName || null,
      phone_e164: phoneE164,
      country_code: countryCode,
      external_reference: externalReference
    })
    .select("id, email, full_name, phone_e164, country_code, external_reference, created_at")
    .single();
  if (error || !data) throw httpError(503, "Merchant customer could not be created.");
  response.status(201).json({ customer: data });
}));

app.get("/api/merchants/:merchantId/orders", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  await requireMerchantRole(database, request.params.merchantId, request.user.id, ["owner", "admin", "finance", "support", "viewer"]);
  const { data, error } = await database.from("orders")
    .select("id, customer_id, order_reference, amount_minor, currency, description, status, idempotency_key, created_at, updated_at")
    .eq("merchant_id", request.params.merchantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw httpError(503, "Merchant orders could not be loaded.");
  response.json({ items: data || [] });
}));

app.post("/api/merchants/:merchantId/orders", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  await requireMerchantRole(database, request.params.merchantId, request.user.id, ["owner", "admin", "finance"]);
  const idempotencyKey = getIdempotencyKey(request);
  const amountMinor = parseAmountToMinor(request.body?.amount);
  const description = validateDescription(request.body?.description);
  const orderReference = request.body?.orderReference
    ? validateOrderReference(request.body.orderReference)
    : "HP-" + randomUUID().slice(0, 8).toUpperCase();
  const customerId = request.body?.customerId ? validateUuid(request.body.customerId, "customer ID") : null;

  if (customerId) {
    const { data: customer, error: customerError } = await database.from("merchant_customers")
      .select("id")
      .eq("id", customerId)
      .eq("merchant_id", request.params.merchantId)
      .maybeSingle();
    if (customerError) throw httpError(503, "Customer ownership could not be verified.");
    if (!customer) throw httpError(404, "The customer does not belong to this merchant.");
  }

  const { data, error } = await database.from("orders")
    .insert({
      merchant_id: request.params.merchantId,
      customer_id: customerId,
      order_reference: orderReference,
      amount_minor: amountMinor,
      currency: "USD",
      description,
      idempotency_key: idempotencyKey
    })
    .select("id, customer_id, order_reference, amount_minor, currency, description, status, created_at")
    .single();

  if (error) {
    if (error.code === "23505") throw httpError(409, "That order reference or idempotency key already exists.");
    throw httpError(503, "Merchant order could not be created.");
  }
  response.status(201).json({ order: data, paymentStatus: "not_started" });
}));

app.get("/api/merchants/:merchantId/payment-links", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  await requireMerchantRole(database, request.params.merchantId, request.user.id, ["owner", "admin", "finance", "viewer"]);
  const { data, error } = await database.from("payment_links")
    .select("id, slug, title, description, amount_minor, currency, status, expires_at, max_uses, use_count, created_at")
    .eq("merchant_id", request.params.merchantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw httpError(503, "Payment links could not be loaded.");
  response.json({ items: data || [] });
}));

app.post("/api/merchants/:merchantId/payment-links", requireAuth, asyncRoute(async (request, response) => {
  const database = getDatabase();
  await requireMerchantRole(database, request.params.merchantId, request.user.id, ["owner", "admin"]);
  const title = validatePaymentLinkTitle(request.body?.title);
  const description = request.body?.description == null ? null : validateDescription(request.body.description);
  const amountMinor = request.body?.amount == null || request.body.amount === ""
    ? null
    : parseAmountToMinor(request.body.amount);
  const maxUses = request.body?.maxUses == null ? null : Number(request.body.maxUses);
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) {
    throw httpError(400, "Maximum uses must be a positive whole number.");
  }
  const slug = randomUUID().replaceAll("-", "").slice(0, 24);
  const { data, error } = await database.from("payment_links")
    .insert({
      merchant_id: request.params.merchantId,
      created_by: request.user.id,
      slug,
      title,
      description,
      amount_minor: amountMinor,
      currency: "USD",
      max_uses: maxUses
    })
    .select("id, slug, title, description, amount_minor, currency, status, expires_at, max_uses, use_count, created_at")
    .single();
  if (error || !data) throw httpError(503, "Payment link could not be created.");
  response.status(201).json({
    paymentLink: data,
    checkoutAvailable: false,
    message: "The payment link is recorded. Public checkout activation requires the merchant PayPal onboarding and checkout flow."
  });
}));

app.post("/api/admin/payouts", requireAuth, asyncRoute(async (request, response) => {
  const adminIds = new Set(
    (process.env.HARBORPAY_ADMIN_USER_IDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );

  if (!adminIds.has(request.user.id)) throw httpError(403, "Administrator access is required.");
  if (process.env.PAYPAL_PAYOUTS_ENABLED !== "true") {
    throw httpError(503, "PayPal Payouts are disabled until merchant approval and operational checks are complete.");
  }
  if (!isPayPalConfigured()) throw httpError(503, "PayPal server credentials are not configured.");

  const idempotencyKey = getIdempotencyKey(request);
  const recipientEmail = validateEmail(request.body?.recipientEmail);
  const amountMinor = parseAmountToMinor(request.body?.amount);
  const amount = minorToDecimalString(amountMinor);
  const currency = (process.env.PAYPAL_CURRENCY || "USD").toUpperCase();
  if (currency !== "USD") throw httpError(503, "Payouts are currently configured for USD only.");

  const database = getDatabase();
  const { data: existing, error: existingError } = await database.from("payouts")
    .select("id, status, provider_batch_id")
    .eq("created_by", request.user.id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingError) throw httpError(503, "The previous payout attempt could not be checked.");
  if (existing) {
    return response.status(202).json({
      payoutId: existing.id,
      status: existing.status,
      providerBatchId: existing.provider_batch_id,
      duplicate: true,
      message: "This payout request already exists. Check PayPal and the payout record before retrying."
    });
  }

  const payoutId = randomUUID();
  const compactId = payoutId.replaceAll("-", "");
  const senderBatchId = "HP" + compactId.slice(0, 27);
  const senderItemId = compactId.slice(0, 30);

  const { error: insertError } = await database.from("payouts").insert({
    id: payoutId,
    idempotency_key: idempotencyKey,
    recipient_email: recipientEmail,
    amount_minor: amountMinor,
    currency,
    status: "processing",
    provider_sender_item_id: senderItemId,
    created_by: request.user.id
  });

  if (insertError) {
    if (insertError.code === "23505") throw httpError(409, "This payout request has already been submitted.");
    throw httpError(503, "The payout audit record could not be created.");
  }

  try {
    const providerResult = await createPayPalPayout({
      payoutId,
      senderBatchId,
      senderItemId,
      recipientEmail,
      amount,
      currency
    });

    const batchId = providerResult.batch_header?.payout_batch_id || null;
    const itemId = providerResult.items?.[0]?.payout_item_id || null;

    const { error: updateError } = await database.from("payouts")
      .update({
        status: "submitted",
        provider_batch_id: batchId,
        provider_item_id: itemId
      })
      .eq("id", payoutId);

    if (updateError) {
      return response.status(202).json({
        payoutId,
        status: "requires_reconciliation",
        message: "PayPal may have accepted the payout. Reconcile the PayPal activity before retrying."
      });
    }

    return response.status(202).json({
      payoutId,
      status: "submitted",
      providerBatchId: batchId
    });
  } catch {
    await database.from("payouts")
      .update({ status: "requires_review" })
      .eq("id", payoutId);

    return response.status(502).json({
      payoutId,
      status: "requires_review",
      error: "PayPal did not provide a confirmed payout response. Review PayPal activity before retrying to avoid a duplicate payment."
    });
  }
}));

app.use((_request, response) => {
  response.status(404).json({ error: "Route not found." });
});

app.use((error, _request, response, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) {
    console.error("HarborPay API error:", error.providerIssue || error.message || "Unknown error");
  }
  response.status(status).json({
    error: status >= 500 ? (error.message || "HarborPay service error.") : error.message
  });
});

app.listen(port, () => {
  console.log("HarborPay API listening on port " + port);
});
