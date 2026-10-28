# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Affiliate Program

- Configurable affiliate programs (versioned, maker-checker approved): who can join, referral codes, commission rules per event (loan disbursed, loan repaid, BNPL order delivered, direct order paid) with fixed or percentage amounts, filters, frequency limits, caps, hold periods, take-backs on reversal/NPL, and payout settings.
- Affiliates, referrals, commissions, payouts and reports under Admin → Affiliates; "Have a referral code?" in the mini-app.
- Daily `affiliate-service` worker task records commissions idempotently; payouts are approved in batches and sent through CBS.
- New tables in migration `20261002090000_add_affiliate_program`; provider-funded commissions post to new Commission Expense / Commission Payable ledger accounts.
- Mini-app **Earn** page (`/earn`) for customers and agents: their code with copy/share, balances (available, on hold, paid), friends invited with their progress, earnings and payments, and the program in plain words.
- Customer sign-up: a program can let customers get their own code on the Earn page without per-customer approval, after a set number of fully repaid loans and with nothing overdue (NPL customers never). Customers may change the generated code once; reserved words are blocked. Only one program can have sign-up on at a time.
- Friends who enter a self-joined customer's code see only the first name and initial. Migration `20261003090000_affiliate_self_service` adds `Affiliate.source` and `Affiliate.codeChangedAt`.
- Self-service withdrawals on the Earn page: people withdraw their available earnings (take-backs netted first, withholding tax applied) to their own account only (the account linked to their phone, or an agent's registered payout account), within a per-program minimum and daily/monthly limits, one at a time.
- Withdrawals up to a per-program amount are sent at once; larger ones wait in Affiliates → Payouts for a checker with Update on Approvals, who approves or declines with a reason and can never review their own. Withdrawals reuse the payout batches (source `SELF_SERVICE`), CBS sending, ledger and retry/release handling; no new tables.
- Optional `AFFILIATE_PAYOUT_SMS=true` texts people when a payout or withdrawal reaches their account (off by default).
- Points rewards: each program pays rewards as **Money** or **Points** (new programs default to Points). Rules still work in Birr; points = reward × the program's points per 1 ETB, fixed when the reward is recorded. Points are added to the person's points wallet when the hold ends (status `CREDITED`), and take-backs remove them.
- Points wallet: append-only `AffiliatePointTransaction` history (Earned / Taken back / Adjusted, `PTS-…` references). Versioned points settings (value of 1 point), changed through maker-checker. Admin **Affiliates → Points** tab with totals, settings, adjustments (maker-checker, never below zero) and searchable history.
- The Earn page shows points: balance with its Birr value, points on hold, and rewards, caps and history in points. Using points comes later; no money moves and points are not posted to provider ledgers. Migration `20261006090000_affiliate_points`.

### Fixes & Improvements

- ASOF_DATE / testing date
  - Added support for an `ASOF_DATE` environment variable and the `getAsOfDate()` helper to allow deterministic date-based testing in both server and UI code.

- Interest / Daily Fee Accrual
  - `simulateDailyInterestAccrual` now returns a consistent detailed result object containing `{ accruals, interestPaid, serviceFeePaid, principalPaid }` so callers can reliably determine what was actually paid.
  - Fixed handling of fixed-per-day fees: payments are applied in priority (service fee → interest → principal) and paid amounts are tracked.
  - Payments made on the interest end date are now considered and applied (previously they were excluded), so principal reduction affects subsequent accrual days.

- Detailed Repayment Calculations
  - Added `calculateInterestWithPaymentsDetailed` and `calculateTotalRepayableDetailed` to return totals plus exact paid allocations (interestPaid, serviceFeePaid, principalPaidFromInterestCalc). UI and backend code now use these detailed results instead of guessing how `repaidAmount` was allocated.

- Payment Callback & Installment Flow
  - Payment callback now includes `payments` when querying a loan and uses `getAsOfDate()` so calculations match the UI during testing.
  - Rollover/merge logic uses the ASOF date to determine overdue installments for merging (so date-forward testing shows merged installments correctly).
  - When a merged (rolled-over) installment is fully paid, all merged installments that were combined into the active one are marked `Paid`, allowing the schedule to advance to the next installment.
  - Payment allocation and ledger posting follow the priority: Penalty → ServiceFee → Interest → Tax → Principal.

- Penalty Behavior
  - `penaltyPerInstallment` is now respected everywhere:
    - If `true`, penalty is calculated per-installment using each installment's due date.
    - If `false`, penalty is calculated at the loan level using the loan's final due date.

- UI & Dashboard
  - Dashboard, product cards, and repayment dialogs use the detailed repayment calculations so `balanceDue`, `interestDue`, and `principalOutstanding` reflect actual allocations after partial payments and ASOF_DATE changes.
  - Rollover/merge logic in dashboard and other pages uses `getAsOfDate()` so merged installments are visible during date-based testing.

---

If you prefer these notes inserted directly into `README.md` instead of a separate `CHANGELOG.md`, I can try again to update `README.md` (the file currently uses an uncommon fenced-block layout which caused the prior patch to fail).