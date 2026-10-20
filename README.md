# HarborPay — Digital Wallet Platform

HarborPay is an original, PayPal-inspired wallet application scaffold. It is not affiliated with or endorsed by PayPal. It must not use PayPal branding to imply official status.

## Included
- Responsive React web dashboard with sample wallet balance, activity history, quick actions, and payment-draft validation.
- Express API with health, wallet summary, transaction sample endpoints, and recipient/amount validation.
- PostgreSQL starter schema and development seed.
- Automated Node.js unit tests.
- Docker Compose for local PostgreSQL development.

## Safety and truthfulness
This project does **not** move real money. The dashboard does not invent a balance or transaction history: those remain unconnected/empty until a real account backend is implemented. Payment form submission validates a draft only. Production payments require provider integration, authenticated users, secure server-side processing, verified webhooks, fraud controls, and compliance review. Never store raw card numbers, CVVs, passwords, or provider secrets in source control.

## Requirements
- Node.js 20+ and npm
- Docker (optional)

## Run locally
```bash
npm install
npm run install:all
npm run dev
```
Open `http://localhost:5173`. API: `http://localhost:4000`.

Alternatively, install separately with `cd server && npm install && npm run dev` and `cd web && npm install && npm run dev` in separate terminals.

Copy `server/.env.example` to `server/.env` before customising server settings. The sample endpoints work without a database connection; the SQL schema is a starting point, not yet connected to the running API.

## Project tree
```text
harborpay-platform/
├── web/                 # React + Vite client
├── server/              # Express API and tests
├── database/            # PostgreSQL schema + dev seed
├── docs/                # Architecture and production checklist
├── docker-compose.yml
└── package.json
```

## Production milestones
1. Add a maintained identity provider and secure session management.
2. Persist users, wallets, payment requests, and an immutable double-entry ledger in PostgreSQL.
3. Integrate a payment provider using hosted checkout/tokenization.
4. Verify signed webhooks, deduplicate events, and reconcile settlement/refunds.
5. Add authorization checks, rate limiting, audit logging, monitoring, backups, and security review.
6. Test the payment-provider sandbox, accessibility, mobile browsers, and migrations before production release.
