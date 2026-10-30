# HarborPay operations and provider configuration

## 1. Create an isolated Supabase project

Create a new Supabase project named HarborPay for this repository. Do not reuse Zovara or another application's project.

In the HarborPay project, run these migrations in order: database/migrations/20261029000100_harborpay_core.sql, then database/migrations/20261030000200_harborpay_merchant_operations.sql. The second migration adds merchants/team permissions, customers, orders, payment links, refunds, disputes, payment-status history, API keys, outbound webhooks, audit events, and atomic inbound-webhook claims. Run database/verify.sql and the Supabase security/performance advisors after both migrations. Enable Email/Password authentication and configure the production email sender and authentication redirect URLs in Supabase. Use the HarborPay web origin as an allowed redirect origin.

The web application needs the project URL and a publishable/anon key. The API needs the same project URL and the service-role key. The service-role key is secret and belongs only in the HarborPay API environment.

## 2. Create a PayPal REST app

Create a PayPal REST application for the HarborPay merchant account. Start with Sandbox mode. Copy the client ID and secret into the API service environment only.

The API uses Orders v2:
- Server creates an order.
- Customer approves the order on PayPal.
- Server captures the approved order.
- The server records completion only after a completed capture response is returned.

PayPal documentation:
- Orders API: https://developer.paypal.com/api/rest/integration/orders-api/
- Webhook integration: https://developer.paypal.com/api/rest/webhooks/rest/
- Payout country support: https://developer.paypal.com/payouts/supported-features/

## 3. Configure the PayPal webhook

Register this HTTPS listener URL in the PayPal REST app:

https://harborpay-api.onrender.com/api/paypal/webhook

Subscribe at minimum to:
- CHECKOUT.ORDER.APPROVED
- PAYMENT.CAPTURE.PENDING
- PAYMENT.CAPTURE.COMPLETED
- PAYMENT.CAPTURE.DENIED
- PAYMENT.CAPTURE.REFUNDED
- PAYMENT.PAYOUTS-ITEM.SUCCEEDED
- PAYMENT.PAYOUTS-ITEM.FAILED
- PAYMENT.PAYOUTS-ITEM.BLOCKED
- PAYMENT.PAYOUTS-ITEM.UNCLAIMED

Copy the webhook ID into PAYPAL_WEBHOOK_ID. HarborPay verifies every webhook through PayPal's verify-webhook-signature API before storing or processing the event. Do not disable verification.

## 4. Render environment variables

Set these on the HarborPay API service:

- PORT=4000
- SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
- SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
- PAYPAL_ENVIRONMENT=sandbox
- PAYPAL_CLIENT_ID=YOUR_SANDBOX_CLIENT_ID
- PAYPAL_CLIENT_SECRET=YOUR_SANDBOX_CLIENT_SECRET
- PAYPAL_WEBHOOK_ID=YOUR_SANDBOX_WEBHOOK_ID
- PAYPAL_CURRENCY=USD
- APP_URL=https://harborpay-web.onrender.com
- WEB_ORIGIN=https://harborpay-web.onrender.com
- PAYPAL_PAYOUTS_ENABLED=false
- HARBORPAY_ADMIN_USER_IDS=YOUR_AUTH_USER_UUID

Set these on the HarborPay static web service:

- VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
- VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY
- VITE_API_URL=https://harborpay-api.onrender.com

The API service and static site are separate Render services. Never set SUPABASE_SERVICE_ROLE_KEY, PAYPAL_CLIENT_SECRET, or PAYPAL_WEBHOOK_ID on the static site.

## 5. Merchant API surface

The API supports authenticated merchant account creation/listing, merchant customer records, merchant order records, and payment-link records. Merchant routes enforce owner/admin/finance/support/viewer roles server-side before using the privileged database client. Order creation returns `paymentStatus: not_started`; it does not collect funds. Payment links are not public checkout URLs yet. The public merchant checkout, merchant onboarding/KYC, settlement and refund workflows must be implemented and tested before these records can be used to represent customer payments.

## 6. Payout controls

PayPal lists Jamaica as a country with the "Send, receive, and withdraw" Payouts feature set. This does not automatically grant Payouts API access to a new merchant account. Confirm access with PayPal before using the endpoint.

Payouts are disabled by default. To enable them, first complete merchant onboarding and PayPal approval, verify the merchant funding source, set PAYPAL_PAYOUTS_ENABLED=true on the API service, and set HARBORPAY_ADMIN_USER_IDS to the exact Supabase Auth UUIDs authorized to initiate merchant disbursements.

The endpoint is POST /api/admin/payouts. It is not a customer wallet withdrawal endpoint and does not promise or calculate a customer's HarborPay balance. It sends money from the merchant's PayPal business account to an email recipient. Review the merchant's legal, contractual, tax, AML, fraud, and consumer-protection duties before enabling it.

## 7. Jamaica regulatory boundary

The Bank of Jamaica describes Payment Service Providers as entities authorized to provide electronic retail payment instruments and services. Its current public PSP page says it is working on amendments to establish a PSP licensing/supervision regime and identifies the FinTech Regulatory Sandbox as the interim controlled testing route. The Bank also publishes a separate remittance licensing framework.

References:
- https://boj.org.jm/core-functions/financial-system/payment-systems/authorised-payment-service-providers/
- https://boj.org.jm/core-functions/financial-system/payment-systems/
- https://boj.org.jm/core-functions/financial-system/cambios-remittance/supervision-of-remittance-services/

This repository does not establish HarborPay's legal authorization. Do not offer public stored-value accounts, custodial balances, money transmission, or remittance services until a qualified Jamaican regulatory/legal review confirms the operating model and required approvals or regulated partners.

## 8. Sandbox verification checklist

1. Register a new HarborPay test user.
2. Confirm the user is created in the HarborPay Supabase Auth project and the profile trigger creates their profile.
3. Create a PayPal Sandbox order from the authenticated web session.
4. Approve the order using a PayPal Sandbox buyer account.
5. Confirm the API captures the order and the provider reports COMPLETED.
6. Confirm the payment row is visible only to its owner.
7. Deliver a signed PayPal webhook and confirm signature verification and event de-duplication.
8. Deliver the same webhook again and confirm it does not create duplicate financial records.
9. Test a denied/pending/refunded event and verify the matching status transition.
10. Confirm an ordinary customer receives 403 for the administrator payout endpoint.
11. Confirm an administrator receives a disabled response while PAYPAL_PAYOUTS_ENABLED=false.
12. Only after sandbox tests and merchant approval, configure Live credentials and a separate Live webhook ID.

No live-money test should be run with real customer funds during initial verification.
