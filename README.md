# HarborPay

HarborPay is a payment application built around real provider transactions. The repository no longer contains sample customer accounts, sample balances, or seeded transaction activity.

## What the application implements

- Supabase Auth for customer registration, login, and authenticated API requests.
- Supabase Postgres records for payment orders, provider capture references, payout records, and verified webhook events.
- PayPal Orders v2 checkout created and captured by the server, never by browser-side secret calls.
- PayPal webhook signature verification and idempotent event storage.
- A restricted server-side PayPal Payouts endpoint for authorized administrators.
- A customer transaction history that reads only records belonging to the signed-in user.
- PostgreSQL migration/RLS/webhook tests, API tests, and a production build check.

## Merchant API

- `GET/POST /api/merchants` — list merchant memberships and create a draft merchant account.
- `GET/POST /api/merchants/:merchantId/customers` — manage merchant customer records.
- `GET/POST /api/merchants/:merchantId/orders` — manage merchant order records. Creating an order does not mean it has been paid.
- `GET/POST /api/merchants/:merchantId/payment-links` — create and list payment-link records. Public checkout is not yet activated.

Every merchant resource request checks the caller's merchant membership and role in the API. The API service role bypasses database RLS, so server-side authorization is mandatory. Payment links are records only until a merchant-specific public checkout flow is implemented and tested.

## Important product boundary

This release is a PayPal checkout and controlled-disbursement integration. It does **not** claim to be a licensed stored-value wallet, does not hold customer funds in an internal HarborPay balance, and does not display a pretend available balance. Checkout payments settle to the merchant's PayPal account. Payouts are disbursements from that merchant account and are disabled until the PayPal account has Payouts access and an administrator explicitly enables the feature.

A customer-held wallet, peer-to-peer stored balances, escrow, or redeemable e-money must not be switched on merely by adding a database column. Get the required Jamaican regulatory advice, authorization, and regulated banking/payment partner arrangements before offering those services. See the Bank of Jamaica references in docs/OPERATIONS.md.

## Repository layout

- web/ — React customer application.
- server/ — Express API, Supabase authentication, PayPal Orders, Payouts, and webhooks.
- database/migrations/ — versioned Supabase core and merchant-operations migrations.
- database/schema.sql — complete schema reference matching both migrations.
- database/tests/ — PostgreSQL schema, RLS, merchant ownership and webhook concurrency checks.
- docs/DATABASE.md — table map and database security boundaries.
- docs/ — architecture and deployment runbook.
- .github/workflows/ — CI checks.

## Local setup

Requirements: Node.js 20 or newer and npm.

1. Create a separate Supabase project for HarborPay. Do not reuse a database belonging to another application.
2. Run both migrations in order in the HarborPay Supabase SQL editor: 20261029000100_harborpay_core.sql, then 20261030000200_harborpay_merchant_operations.sql.
3. Create a PayPal REST application in the PayPal Developer Dashboard. Start with Sandbox credentials.
4. Copy server/.env.example to server/.env and fill in the server-only secrets.
5. Copy web/.env.example to web/.env.local and set the public Supabase URL/key and API URL.
6. Install dependencies with npm install followed by npm run install:all.
7. Start the API and web client with npm run dev.
8. Run npm test before deployment.

The frontend uses the Supabase publishable/anon key. The API uses the Supabase service-role key. Never put a service-role key, PayPal client secret, or webhook secret in the web environment or source control.

## PayPal checkout flow

1. The signed-in customer submits an amount and description.
2. The API validates the amount and creates a HarborPay payment record.
3. The API creates a PayPal Orders v2 order and returns the provider approval URL.
4. The customer approves the transaction on PayPal.
5. PayPal returns the customer to HarborPay and the API captures the order.
6. The application marks the payment completed only when PayPal returns a completed capture with the expected amount and currency.
7. A verified webhook independently reconciles later provider events.

A browser redirect alone is never treated as proof of payment.

## Configuration and release

See docs/OPERATIONS.md for the exact Supabase, PayPal, webhook, Render, and release configuration.

The repository contains integration code, not your private merchant credentials. Real-money activity cannot be activated until your own Supabase project, PayPal app, webhook, merchant review, and live credentials are configured and verified. Sandbox mode is the default. Do not set PayPal to live mode until your merchant account is approved and end-to-end tests pass.
