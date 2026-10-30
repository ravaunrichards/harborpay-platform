# HarborPay database model

HarborPay is a PayPal-backed payment-processing application. This schema records payment and merchant operations; it does not create a customer-held wallet or pretend that funds are held by HarborPay.

## Identity and ownership

- `profiles`: customer identity metadata linked to Supabase Auth users.
- `merchant_accounts`: distinct merchant/business spaces, each with an owner.
- `merchant_members`: explicit team roles for merchant owners, administrators, finance, support, developers, and read-only users.
- A database trigger creates the owner membership when a merchant account is created.

## Payment operations

- `merchant_customers`: customer records scoped to one merchant.
- `orders`: merchant order references, amount, currency, customer, and lifecycle status.
- `payment_links`: fixed-amount or customer-entered amount links.
- `payments`: PayPal order and capture references, amount, currency, status, associated merchant/order/customer, and fees/net metadata.
- `payment_status_events`: append-only status history.

## Refunds, disputes, and payouts

- `refunds`: idempotent provider refund requests and results.
- `disputes`: provider dispute/case references, status, evidence deadline, and response timestamps.
- `payouts`: administrator-controlled PayPal disbursement audit records. Payout execution remains disabled until the PayPal business account is approved and enabled.

## Platform operations and security

- `merchant_api_keys`: hashed API keys only; plaintext keys must never be stored.
- `merchant_webhook_endpoints` and `webhook_deliveries`: encrypted endpoint signing secrets and retryable outbound delivery records.
- `webhook_events`: verified inbound PayPal webhook bodies with atomic processing leases, attempt counters, and failure notes.
- `audit_events`: administrative and merchant activity audit trail.
- Row-level security is enabled on all new public tables. Customer and merchant reads are ownership-scoped; privileged writes remain server-side through the Supabase service role.
- Three service-role-only RPC functions atomically claim, complete, and release PayPal webhook work to prevent concurrent duplicate processing.

## Migrations

1. `20261029000100_harborpay_core.sql` — profiles, payments, payouts, and inbound webhook records.
2. `20261030000200_harborpay_merchant_operations.sql` — merchant accounts/team roles, customers, orders, payment links, refunds, disputes, status history, API keys, outbound webhooks, audit trail, and webhook processing leases.

The complete reference SQL is in `database/schema.sql`.

## Verification

After provisioning HarborPay's own Supabase project, apply migrations in ascending order and run Supabase security and performance advisors. Verify the presence of the new tables, RLS enablement, policies, and service-role-only RPC grants before connecting production traffic.

Do not reuse another application's database. Do not store PAN/CVV data. Payment card entry and settlement remain with PayPal. A regulated stored-value wallet, escrow product, or customer-held balance is outside this schema and requires separate legal, regulatory, ledger, and partner controls.
