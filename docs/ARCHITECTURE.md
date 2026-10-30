# HarborPay architecture

## Runtime components

- React/Vite web application: Supabase Auth sign-in and sign-up, authenticated payment creation, PayPal approval redirect, and the signed-in customer's own payment records.
- Express API: verifies Supabase access tokens, creates/captures PayPal orders, reads owner-scoped payment history, verifies PayPal webhooks, and exposes an administrator-gated Payouts endpoint.
- Supabase Auth: identity and session issuance.
- Supabase Postgres: customer profiles, payment order records, payout audit records, and verified webhook event storage.
- PayPal REST APIs: hosted checkout, capture, and (when explicitly enabled and approved) business payouts.

## Funds and ledger boundary

HarborPay does not create an internal balance or represent funds as customer-held money. PayPal checkout proceeds settle to the configured merchant account. The payment table is a provider transaction record, not a spendable account ledger. Payouts are outgoing disbursements from the merchant's PayPal business account and are callable only by an administrator whose Supabase user ID is allowlisted on the server.

Do not add wallet balances, peer-to-peer stored value, escrow, or customer-initiated withdrawals without legal authorization, the necessary regulated partner model, operational controls, and a complete reconciled double-entry ledger.

## Trust boundaries

1. The browser receives only a Supabase public/publishable key and a short-lived user access token.
2. The server validates the access token with Supabase Auth on every protected request.
3. The Supabase service-role key and PayPal client secret remain server-only.
4. PayPal order creation and capture happen on the server.
5. Payment status changes come from a verified PayPal capture response or a signature-verified PayPal webhook.
6. Webhook IDs are unique, and failed processing remains unprocessed so a later provider retry can be processed.
7. All customer payment reads are filtered by the authenticated user ID, even though the backend uses a service-role database client.
8. Payout execution is disabled by default and restricted to an explicit administrator allowlist.

## Financial record statuses

- created: the payment record exists and the provider order has been created.
- approved: PayPal reports buyer approval; no completion claim is made yet.
- pending: PayPal reports a pending capture.
- completed: PayPal confirms a completed capture.
- failed: PayPal definitively rejects the payment.
- cancelled: the customer returns through the cancellation route before capture.
- refunded: a verified PayPal refund event is received.
- review_required: provider amount/currency data does not match the local payment record.

No status is generated from a local-only button click.
