# Architecture and implementation boundaries

## Current repository
- `web/`: responsive React client. It displays explicit preview-mode warnings and reads empty/unconnected wallet state from the API until real financial data is implemented.
- `server/`: Express API with Helmet, JSON size limit, CORS allowlist, health endpoint, local sample endpoints, and payment-draft validation.
- `database/`: PostgreSQL starting schema for users, wallets, transaction records, tokenized payment methods, and payment requests.
- `server/test/`: Node built-in test runner for amount and recipient validation.

## Deliberate limitations
- No real authentication or user sessions yet.
- No persistent wallet ledger connected to the API, payment execution, card vault, or provider webhooks.
- No synthetic balance or transaction history is presented as account data. Draft validation does not authorize or execute a payment.
- The payment-request form currently validates the same draft format; it does not send a real request.

## Production integration checklist
- Identity: use a maintained identity provider, secure cookies, CSRF protection where applicable, MFA, session rotation, and recovery flows.
- Ledger: store money as integer minor units; use double-entry postings, atomic database transactions, immutable audit records, and idempotency keys.
- Payments: use provider-hosted checkout/tokenization; never receive or store raw card data or CVV. Keep provider credentials server-side.
- Webhooks: verify signatures against the raw request body, deduplicate event IDs, and reconcile against provider status.
- Security: rate limits, input schemas, authorization on every resource, secret management, dependency scanning, redacted logs, backups, and recovery drills.
- Compliance: obtain qualified advice on Jamaica availability, licensing, KYC/AML, privacy, consumer protection, taxes, and cross-border payments.
- Testing: provider sandbox integration, access-control tests, accessibility checks, mobile browser checks, and database migration tests.
- Deployment: separate development/staging/production secrets and databases. Do not deploy until explicitly approved.
