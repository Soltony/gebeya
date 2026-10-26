# LoanFlow - Advanced Micro-Credit Platform

LoanFlow is a comprehensive, multi-provider micro-credit platform built with a modern technology stack. It provides a robust solution for managing the entire loan lifecycle, from initial provider configuration and dynamic credit scoring to borrower application, automated processing, and final repayment. The platform features distinct interfaces for administrators and borrowers, a maker-checker approval workflow for critical changes, and a sophisticated Loan Cycle feature to manage credit progression.

## ✨ Key Features

*   **Admin & Borrower Interfaces**: A secure, feature-rich admin dashboard for management and a separate, simplified flow for borrowers to apply for loans.
*   **Multi-Provider & Product Management**: Administrators can create and configure multiple loan providers (e.g., different banks) and define various loan products with unique rules, fees, and interest rates.
*   **Dynamic Credit Scoring Engine**: Each provider can build their own weighted credit scoring model using a powerful rules engine. This allows them to weigh different data points (like income or employment status) to automatically determine a borrower's eligibility and maximum loan amount.
*   **Loan Cycle Progression**: A sophisticated, grade-based feature that manages a borrower's access to their full credit limit. The system encourages good repayment behavior by gradually increasing a borrower's trust and access to capital based on their performance across multiple loans. Administrators can configure the progression metric (e.g., total loans taken, on-time repayments) and the payout percentages for each cycle.
*   **End-to-End Loan Lifecycle**: Borrowers can check eligibility, apply for a loan, and receive funds. The system tracks the entire lifecycle, including disbursement, daily fee accrual, penalties, repayments, and overdue statuses.
*   **Maker-Checker (Approval) Workflow**: Critical administrative actions, such as changing product rules, provider settings, or tax configurations, are submitted for approval by a designated "Approver" role, ensuring data integrity and operational control.
*   **Automated Backend Processes**: The application includes scheduled background services for processing automated loan repayments from borrower accounts and for identifying and flagging Non-Performing Loans (NPLs) based on configurable rules.
*   **Comprehensive Reporting & Auditing**: Admins have access to a detailed, exportable reporting suite to monitor key metrics like portfolio health, collections, income, and fund utilization. All critical actions are logged for compliance and security.
*   **Role-Based Access Control (RBAC)**: The platform features a granular access control system, allowing administrators to define roles and permissions for different user types, restricting access to sensitive data and features.

---

## 🛠️ Technology Stack

*   **Framework**: [Next.js](https://nextjs.org/) (App Router)
*   **Language**: [TypeScript](https://www.typescriptlang.org/)
*   **UI Library**: [React](https://reactjs.org/)
*   **Styling**: [Tailwind CSS](https://tailwindcss.com/)
*   **UI Components**: [ShadCN UI](https://ui.shadcn.com/)
*   **Database ORM**: [Prisma](https://www.prisma.io/)
*   **Database**: SQL Server
*   **Authentication**: Custom session management using [jose](https://github.com/panva/jose) for JWTs
*   **Password Hashing**: [bcryptjs](https://github.com/dcodeIO/bcrypt.js)
*   **File Parsing**: [xlsx](https://github.com/SheetJS/sheetjs) for Excel data uploads

---

## 🚀 Getting Started

Follow these instructions to get the project up and running on your local machine for development and testing purposes.

### Prerequisites

*   [Node.js](https://nodejs.org/) (v18 or later recommended)
*   [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
*   A running instance of [SQL Server](https://www.microsoft.com/en-us/sql-server/)

### 1. Installation

Clone the repository and install the project dependencies.

```bash
git clone <your-repository-url>
cd LoanFlow
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root of the project and add your SQL Server database connection string.

```env
# Example for SQL Server
DATABASE_URL="sqlserver://USER:PASSWORD@HOST:PORT;database=DATABASE_NAME;trustServerCertificate=true"
```

Replace the placeholders with your actual database credentials.

### 3. Database Setup

Run the Prisma commands to create the database schema and apply any pending migrations.

```bash
npx prisma migrate dev --name init
```

This will synchronize your database schema with the `prisma/schema.prisma` file.

### 4. Seed the Database

Run the seed script to populate your database with initial data, including default roles, users, providers, and products.

```bash
npx prisma db seed
```

#### Default Admin Credentials:
*   **Phone Number**: `0900000000`
*   **Password**: `SuperAdm!2025`

### 5. Run the Development Server

Start the Next.js development server to run the application.

```bash
npm run dev
```

The application will be available at [http://localhost:9002](http://localhost:9002).

---

## ⚙️ Background Worker

The project includes a worker script for handling scheduled tasks like automated repayments and NPL flagging.

*   **To run the NPL status update once:**
    ```bash
    npm run run:worker -- npl
    ```
*   **To start the automated repayment service (long-running process):**
    ```bash
    npm run run:worker -- repayment-service
    ```

*   **To run the provider distribution once (posts Interest/ServiceFee/Penalty/Tax Received to upstream and clears received balances on success):**
    ```bash
    npm run run:worker -- provider-distribution
    ```

*   **To start the provider distribution service (runs periodically):**
    ```bash
    npm run run:worker -- provider-distribution-service
    ```

### External Distribution API (optional)

The provider distribution worker posts to the upstream endpoint using HTTP Basic Auth.

```env
EXTERNAL_DISTRIBUTION_URL="http://192.168.100.56:8280/nibtera-loan/distribution"
EXTERNAL_API_USERNAME="nibLoan"
EXTERNAL_API_PASSWORD="123456"
```

---

## 🤖 Telegram Bot & Mini App

The marketplace is also available as a Telegram Mini App at `/tg`, with a bot that links the customer's phone number and sends order updates. The Telegram shop lists only items whose selling option is **Direct Payment Only** (`DIRECT_ONLY`) or **Both (BNPL + Direct)** (`BOTH`); customers place **direct** (non-credit) orders for them, track them and cancel them. **BNPL Only** items are not shown in Telegram at all — they stay in the Nib app — and `BOTH` items can only be paid directly in Telegram. Nothing is charged when an order is placed; the customer pays on delivery with a **NIB USSD push** (see [NIB USSD push payments](#-nib-ussd-push-payments) below). Telegram orders are tagged with a **Telegram** badge on the admin Orders page.

### 1. Create the bot (BotFather)

1. `/newbot` → note the token and username.
2. `/newapp` → choose the bot, give the Mini App a short name (e.g. `shop`) and set its URL to `TELEGRAM_MINIAPP_URL`.
3. `/setjoingroups` → Disable (the bot only serves private chats).

### 2. Configure the environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token. Unset = Telegram features disabled. |
| `TELEGRAM_MINIAPP_URL` | yes | Public HTTPS URL of `/tg`, e.g. `https://nibterabnpl.nibbank.com.et/tg`. |
| `TELEGRAM_UPDATE_MODE` | yes | `webhook` (Telegram calls us) or `polling` (worker calls Telegram). |
| `TELEGRAM_WEBHOOK_URL` | webhook | Public URL of `/api/telegram/webhook`. |
| `TELEGRAM_WEBHOOK_SECRET` | webhook | 16–256 chars of `A-Z a-z 0-9 _ -`; checked on every webhook call. |
| `TELEGRAM_BOT_USERNAME` | no | Enables share links and the "open the bot" link. |
| `TELEGRAM_MINIAPP_SHORT_NAME` | no | Enables `t.me/<bot>/<app>?startapp=item_<id>` deep links. |
| `TELEGRAM_API_BASE_URL` | no | Proxy or self-hosted Bot API server if `api.telegram.org` is blocked. |
| `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS` | no | Mini App session lifetime, default 86400. |
| `TELEGRAM_SUPPORT_TEXT` | no | Appended to the bot's `/help` reply. |
| `TELEGRAM_DEV_BYPASS_USER_ID` | dev only | Open `/tg` in a normal browser as this Telegram user (ignored in production). |

### 3. Apply the database migration

```bash
npx prisma migrate deploy
```

Adds the `TelegramUser` table and an `Order.channel` column (`SUPER_APP` default, `TELEGRAM` for Mini App orders).

### 4. Register the bot settings with Telegram

```bash
npx tsx -r tsconfig-paths/register scripts/telegram-setup.ts          # commands, menu button, webhook/polling
npx tsx -r tsconfig-paths/register scripts/telegram-setup.ts --info   # show current webhook + menu state
```

Re-run after changing any `TELEGRAM_*` value.

### 5. Receive updates

* **Webhook mode:** nothing else to run — the app handles `POST /api/telegram/webhook`.
* **Polling mode** (server not reachable from the internet): run exactly one instance of
    ```bash
    npm run run:worker -- telegram-bot
    ```
    Start it from the project folder: the worker has no dotenv loader of its own and picks up `.env` through Prisma when it starts (system environment variables take precedence). Rebuild `dist/worker.cjs` with `npm run build:worker` so it includes the `telegram-bot` task. Run only one poller (`node dist/worker.cjs telegram-bot` *or* `npm run run:worker -- telegram-bot`) — Telegram rejects a second one with `409 Conflict`.
* Either way, `TELEGRAM_MINIAPP_URL` must be reachable over HTTPS from customers' phones — the Mini App page and `/api/tg/*` are loaded by their Telegram app.

### How it fits together

* **Identity:** the Mini App sends Telegram's signed `initData` on every `/api/tg/*` request (`Authorization: tma …`); the server verifies it with the bot token. The customer's phone is linked only from a contact they share with the bot for their own account, normalized to the `251XXXXXXXXX` borrower id.
* **Pricing:** `src/lib/marketplace/order-pricing.ts` is shared with the super-app order route, so both channels charge the same for the same basket.
* **Notifications:** when a merchant changes a Telegram order's status in the admin panel, the customer gets a bot message with a button back to the order. Payment results (received, not completed, being confirmed) are sent the same way.
* **Telegram SDK:** `public/telegram-web-app.js` is a copy of Telegram's Mini App script, served from our own domain because `telegram.org` is not reliably reachable from customers' networks. It provides Telegram's back arrow, bottom button and theme. Refresh it occasionally with `curl -o public/telegram-web-app.js https://telegram.org/js/telegram-web-app.js`. If it fails to load, the app falls back to in-page Back and Order buttons.

---

## 📲 NIB USSD Push Payments

Telegram customers pay for direct orders with a NIB push payment: we send the amount and the customer's phone to the bank's push service, the bank sends a USSD PIN prompt to that phone, the customer approves it with their PIN, and the bank posts the result back to us. The customer never shares an account number. The integration follows NIB's *Push Payment Integration Guide* v1.0 (May 2026); section numbers below (§) refer to it.

### The flow

1. The order reaches **On the way** (`ON_DELIVERY`), as for direct payments in the super app. The Mini App then shows **Pay <amount>** on the order screen.
2. `POST /api/tg/orders/:id/pay` sends the encrypted transfer request (§5.3). The prompt goes to the phone linked to the Telegram account, the amount is the order total, and the money is credited straight to the merchant's NIB account (the merchant's **Account Number**, sent as `creditAccount`: dynamic routing, §10.3). An order from a merchant with no account number on file shows no Pay button. Super-app direct payments still go to the provider collection account. The bank's 200 only means the prompt was sent; the attempt waits in `AWAITING_PIN`. A number the bank doesn't know gets 400 "User not found", which the customer sees as "isn't registered with NIB".
3. The bank posts the encrypted result to our callback URL, `POST /api/nib-push/callback` (§7). On success the order becomes **Delivered**, the bank's FT number is recorded, and the customer gets a bot message. The URL can't be sent with the request (the transfer schema rejects a `resultUrl` field), so **the bank must have it registered on our profile** (§10.1); until it does, no callback comes.
4. While the customer waits, the Mini App polls `GET /api/tg/orders/:id/pay` every 3 s, and the server asks the bank's status endpoint (§5.5) at most every 10 s per attempt in case the callback is late. The customer can resend the prompt after 60 s; open attempts are checked with the bank first (§8.2), each resend is a new attempt with a new reference, and a late callback on an older one is still matched.

Every attempt is a `DirectPendingPayment` row with `method = USSD_PUSH`, so it appears in **Reports → Direct Payment** (and its Excel export) next to super-app payments: customer name and phone, the order reference the customer sees, channel, a plain-language status with the bank's reason, FT and paid time.

**When the bank never reports back.** If the customer was debited but neither a callback nor the status endpoint confirms it, an operator settles it from the bank statement: **Pending Payments → Order payments**, find the payment, **Mark Paid** with the FT. A second user approves it under **Pending Payment Approvals**; the payment is then recorded exactly as a bank confirmation would record it (FT stored, order delivered, customer messaged). An FT can settle only one payment.

| Status | Meaning |
| --- | --- |
| `PENDING` | Created, and the bank hasn't confirmed it: no answer yet, no answer at all, a 409 or a 5xx. The request may still have been taken, so only the status endpoint closes it (a 404 there fails it). |
| `AWAITING_PIN` | Prompt sent; waiting for the customer. |
| `COMPLETED` | Paid. The FT is in `DirectPaymentFt`, where one FT can settle only one payment. |
| `FAILED` | Declined (wrong PIN, no balance) or rejected by the bank. The customer can try again. |
| `PROCESSING` | The bank reported a failure that may still have moved money: `statusCode 1` with an FT or "server busy", success after a recorded failure, a different amount, or an FT already used elsewhere. The customer is told not to pay again; an operator confirms it against the bank statement. |

Audit log actions: `DIRECT_PAYMENT_PUSH_REQUEST`, `DIRECT_PAYMENT_SUCCESS`, `DIRECT_PAYMENT_FAILED`, `DIRECT_PAYMENT_NEEDS_REVIEW` and `DIRECT_PAYMENT_NEEDS_REFUND` (money for an order that was already paid or was cancelled while the customer entered their PIN).

### Configure the environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NIB_PUSH_BASE_URL` | yes | Bank base URL for UAT or production. Unset = paying in Telegram disabled. |
| `NIB_PUSH_USERNAME` / `NIB_PUSH_PASSWORD` | yes | HTTP Basic credentials the bank issued (§2.1), per environment. |
| `NIB_PUSH_COMPANY` | yes | Our company identifier code (`company`, §10.3). We choose it and register it with the bank: globally unique, short (under 6 characters), ALL CAPS, e.g. `NIBBANK`. |
| `NIB_PUSH_CALLBACK_USERNAME` / `NIB_PUSH_CALLBACK_PASSWORD` | yes | Basic credentials **we** choose and give the bank; it sends them on every callback (§10.1). A callback without them is accepted only if it is encrypted with the bank's own key (so it can only come from the bank); anything else gets 401. |
| `NIB_PUSH_SERVER_PRIVATE_KEY` | yes | Our long-term secp256k1 private key (64 hex characters or base64). The bank encrypts callbacks to its public half (§10.2). |
| `NIB_PUSH_CHECKSUM` | no | What the outbound `cksum` covers: `bytes` (default) or `hex`. See below. |
| `NIB_PUSH_BANK_PUBLIC_KEY` | no | The bank's public key (base64), used only when `get-pub-key` doesn't answer within 8 s. Copy it from a successful `get-pub-key` call. |
| `NIB_PUSH_RECONCILE_INTERVAL_MINUTES` | no | How often the reconciliation worker runs, default 5. |

Generate the server key once per environment and keep it out of source control:

```bash
node -e "const e=require('crypto').createECDH('secp256k1');e.generateKeys();console.log('NIB_PUSH_SERVER_PRIVATE_KEY=' + e.getPrivateKey('hex'));console.log('public key for NIB: ' + e.getPublicKey('base64'))"
```

**Checksum.** §4.2 says `cksum` is SHA-256 over the *hex text* of the ciphertext, and that hashing raw bytes gets a 401. The requests in the bank's Postman collection, including one it answered with 200, hash the *raw bytes*. `bytes` is the default because it is the one seen working; if transfers come back 401 "Checksum mismatch", set `NIB_PUSH_CHECKSUM=hex`. Inbound checksums are accepted either way.

### Give the bank (provisioning, §10)

* **Company identifier code:** the value of `NIB_PUSH_COMPANY` (§10.3).
* **Callback URL (`resultUrl`):** `https://<host>/api/nib-push/callback`.
* **Callback credentials:** `NIB_PUSH_CALLBACK_USERNAME` and `NIB_PUSH_CALLBACK_PASSWORD`.
* **Our public key**, either option: **B (static)**, the base64 uncompressed key derived from `NIB_PUSH_SERVER_PRIVATE_KEY` (printed by the command above); or **A (URL)**, `GET https://<host>/api/nib-push/public-key`, protected by the same callback credentials, which returns `{ "publicKey": "…" }`.
* **Credit account routing:** tell the bank we route dynamically: every request carries the merchant's account as `creditAccount` (§10.3). Ask whether they validate credit accounts against a list; if so, they need each merchant's account.

The guide also requires HTTPS and a site-to-site IPSec VPN (§3).

**Where UAT differs from the guide** (handled in `src/lib/nib-push/push-payments.ts`):

* The inner transfer payload is checked against a strict schema: only the seven §5.3.1 fields are allowed, and anything else (e.g. `resultUrl`) is refused with "object instance has properties which are not allowed by the schema".
* Wrong or missing credentials come back as HTTP 200 with `{ "statusCode": 401, "details": "Invalid Credentials" }` in the body, so the body's `statusCode` decides.
* The status endpoint (§5.5) answers **every** reference, including paid ones, with 401 and an empty, unencrypted status body, so it cannot confirm anything on UAT; only the callback (or an operator) can. Ask NIB to fix it or to tell us which credentials it needs. Only a real 404 is read as "no record".

### Apply the database migration

```bash
npx prisma migrate deploy
```

Adds `method`, `customerPhone`, `sharedSecret`, `clientPrivateKey`, `statusDesc`, `payerAccount`, `statusCheckedAt` and `completedAt` to `DirectPendingPayment`, and the `DirectPaymentFt` table.

### Run the reconciliation worker

Attempts whose callback never came (30 minutes to 24 hours old) are settled from the bank's status endpoint: `PAID` completes them, `NOT_PAID` fails them, `PENDING` leaves them.

```bash
npm run run:worker -- nib-push-reconcile-service   # long-running, every NIB_PUSH_RECONCILE_INTERVAL_MINUTES
npm run run:worker -- nib-push-reconcile           # one sweep
```

Rebuild `dist/worker.cjs` with `npm run build:worker` to include these tasks.

### Security

Every payload in both directions is AES-256-GCM encrypted with a key agreed by ECDH on secp256k1 (`src/lib/nib-push/crypto.ts`, guide §4 and §6). Each request uses a fresh one-time key pair (§4.3); its private key and the agreed secret are stored on the attempt (`DirectPendingPayment.clientPrivateKey` and `sharedSecret`) to open the bank's status replies, and are never logged or returned by an API. Callbacks carry no reference in clear and are opened with our server key and the `pubkey` in the envelope (§7.3). If that fails, the last day's attempts' keys are tried in case the bank used an attempt's one-time key; a GCM tag that verifies identifies the attempt. Opening a callback does not by itself prove the bank sent it, since anyone can encrypt to our public key, so it must also carry our Basic credentials, or open with a key only the bank holds: the attempt's agreed secret, or a derivation with a known bank public key (cached from get-pub-key, or `NIB_PUSH_BANK_PUBLIC_KEY`). The checksum is checked before decrypting and the GCM tag while decrypting; rejected callbacks are logged as `SECURITY`. Phone and account numbers are masked in logs.

### Try it locally

`scripts/mock-nib-push.cjs` stands in for the bank as the guide describes it: it serves get-pub-key, transfer and status with the same encryption, answers 409 for a repeated reference and 400 "User not found" for phones ending in `0000`, and posts the callback a few seconds after each transfer.

```bash
MOCK_PARTNER_PUBLIC_KEY=<our public key> node scripts/mock-nib-push.cjs   # MOCK_OUTCOME=success|decline|busy|silent-paid|silent
```

Run the app with `NIB_PUSH_BASE_URL=http://localhost:4010`, `NIB_PUSH_USERNAME=mock`, `NIB_PUSH_PASSWORD=mock`, `NIB_PUSH_COMPANY=GEBEYA`, `NIB_PUSH_CALLBACK_USERNAME=nib`, `NIB_PUSH_CALLBACK_PASSWORD=mock-callback` and the server key whose public half you gave the mock, then pay for an order that is **On the way** in the Mini App.

### Not built yet

Refunds (§5.6, §5.7) are not wired in. Payments flagged `DIRECT_PAYMENT_NEEDS_REFUND` are refunded by operations for now.
