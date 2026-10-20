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

The marketplace is also available as a Telegram Mini App at `/tg`, with a bot that links the customer's phone number and sends order updates. Customers can browse, place **direct** (non-credit) orders for items whose selling option is `DIRECT_ONLY` or `BOTH`, track them and cancel them. BNPL-only items are shown but can only be bought in the Nib app. Payment is not collected in Telegram yet; Telegram orders are tagged with a **Telegram** badge on the admin Orders page.

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
    The worker does not read `.env`, so the `TELEGRAM_*` variables must be set in its environment (system variables or `set` lines in its `.cmd` wrapper). Rebuild `dist/worker.cjs` with `npm run build:worker` so it includes the `telegram-bot` task.
* Either way, `TELEGRAM_MINIAPP_URL` must be reachable over HTTPS from customers' phones — the Mini App page and `/api/tg/*` are loaded by their Telegram app.

### How it fits together

* **Identity:** the Mini App sends Telegram's signed `initData` on every `/api/tg/*` request (`Authorization: tma …`); the server verifies it with the bot token. The customer's phone is linked only from a contact they share with the bot for their own account, normalized to the `251XXXXXXXXX` borrower id.
* **Pricing:** `src/lib/marketplace/order-pricing.ts` is shared with the super-app order route, so both channels charge the same for the same basket.
* **Notifications:** when a merchant changes a Telegram order's status in the admin panel, the customer gets a bot message with a button back to the order.
