# Changelog

All notable changes to this project are documented in this file.

## Unreleased

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