import { calculateTotalRepayable } from './loan-calculator';
import { calculateInstallmentPenalty } from './installment-penalty';
import { roundCurrency } from './interest-accrual';
import { isSettledStatus } from './installment-status';
import type { Tax } from './types';

/**
 * Single source of truth for "how much is due right now" on a loan.
 *
 * Why this module exists: the dashboard, the history page, the repayment
 * dialog and both payment API routes each used to compute their own balance.
 * The server billed a fresh service-fee share (totals.serviceFee / N) on
 * EVERY payment with no memory of fees already collected, so repeat payments
 * to the same installment were swallowed as fee income and never reached
 * principal, while merged installments lost their fee share entirely.
 *
 * Key ideas:
 *
 * 1. Fees collected so far are DERIVED, not guessed:
 *      feesCollected = loan.repaidAmount - SUM(installment.paidAmount)
 *    because installment.paidAmount only ever accumulates penalty+principal;
 *    everything else a borrower paid was fee/interest/tax.
 *
 * 2. Fees are earned pro-rata with principal ("entitlement"): by the time
 *    the borrower has been billed through installment k, the lender is
 *    entitled to totalFees * (principal scheduled through k) / totalPrincipal.
 *    Merged installments carry their principal forward into the successor,
 *    so their fee share automatically travels with them and is billed on the
 *    successor instead of being lost. Once entitlement is met, the fee
 *    portion of the quote is zero — a repeat payment can never re-bill it.
 *
 * All monetary outputs are rounded to 2dp so the client quote, the server
 * guard and the settlement check all agree to the cent.
 */

export const MONEY_EPSILON = 0.01;

/**
 * Tolerance when deciding a whole LOAN is settled. Per-payment quotes are
 * rounded to the cent, so across several installments the received total can
 * legitimately drift a few cents from the computed total repayable.
 */
export const LOAN_SETTLE_EPSILON = 0.1;

export interface InstallmentLike {
  id: string;
  installmentNumber: number;
  dueDate: Date | string;
  amount: number;
  paidAmount?: number | null;
  status: string;
  isActive?: boolean | null;
}

export interface ActiveInstallmentDue {
  installmentId: string;
  installmentNumber: number;
  /** Principal still owed on the active installment. */
  principalRemaining: number;
  /** Penalty accrued on the active installment and not yet paid. */
  penaltyRemaining: number;
  /** Total accrued penalty for the installment (paid + unpaid), for records. */
  penaltyForInstallment: number;
  /** Fee/interest/tax owed with this installment (entitlement minus collected). */
  serviceFeeDue: number;
  interestDue: number;
  taxDue: number;
  /** Sum of the above, rounded — the amount to quote and to guard against. */
  total: number;
}

export interface LoanDueContext {
  loanAmount: number;
  repaidAmount?: number | null;
  dueDate: Date | string;
  disbursedDate: Date | string;
  payments?: unknown;
}

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Round UP to the next cent (with a float-noise guard). Used for remainders:
 * quoting 0.005 as 0.00 would make a dusty installment unpayable forever,
 * while quoting it as 0.01 lets the settlement check snap it closed.
 */
const ceilCurrency = (v: number) => (v <= 0 ? 0 : Math.ceil(v * 100 - 1e-6) / 100);

const safeParse = (field: unknown, defaultValue: unknown) => {
  if (typeof field === 'string') {
    try { return JSON.parse(field); } catch { return defaultValue; }
  }
  return field ?? defaultValue;
};

/**
 * Compute the amount due for the ACTIVE installment of an installment-based
 * loan. Returns null when the loan has no payable active installment.
 *
 * `loan` must carry repaidAmount and (when the product has a daily fee) its
 * payments, since interest is computed on the declining balance.
 * `installments` must be ALL installments of the loan, any order.
 */
export function computeActiveInstallmentDue(
  loan: LoanDueContext,
  product: unknown,
  taxConfigs: Tax[],
  installments: InstallmentLike[],
  asOfDate: Date,
): ActiveInstallmentDue | null {
  const sorted = [...installments].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const active = sorted.find((i) => i.isActive && !isSettledStatus(i.status) && num(i.amount) > 0);
  if (!active) return null;

  const totals = calculateTotalRepayable(loan as never, product as never, taxConfigs ?? [], asOfDate);
  const totalPrincipal = num(loan.loanAmount);
  const totalFees = num(totals.serviceFee) + num(totals.interest) + num(totals.tax);

  // --- penalty on the active installment ---------------------------------
  const productAny = product as { penaltyRules?: unknown; penaltyPerInstallment?: boolean };
  const penaltyRules = safeParse(productAny.penaltyRules, []) as never[];
  const penaltyPerInstallment = productAny.penaltyPerInstallment ?? false;
  const penaltyDueDate = penaltyPerInstallment ? new Date(active.dueDate) : new Date(loan.dueDate);

  const paidSoFar = num(active.paidAmount);
  // paidAmount accumulates penalty first, then principal (matches the
  // payment waterfall), so split it back apart the same way.
  const principalOutstandingForPenalty = Math.max(0, num(active.amount) - paidSoFar);
  const penaltyForInstallment = calculateInstallmentPenalty({
    dueDate: penaltyDueDate,
    principalOutstanding: principalOutstandingForPenalty,
    penaltyRules,
    asOfDate,
  });
  const penaltyPaidSoFar = Math.min(paidSoFar, penaltyForInstallment);
  const principalPaidSoFar = Math.max(0, paidSoFar - penaltyPaidSoFar);
  const principalRemaining = ceilCurrency(Math.max(0, num(active.amount) - principalPaidSoFar));
  const penaltyRemaining = ceilCurrency(Math.max(0, penaltyForInstallment - penaltyPaidSoFar));

  // --- fee entitlement ----------------------------------------------------
  // Principal scheduled AFTER the active installment. Merged rows hold 0 and
  // rows merged into the active one already count inside active.amount.
  const futurePrincipal = sorted
    .filter((i) => i.installmentNumber > active.installmentNumber)
    .reduce((acc, i) => acc + Math.max(0, num(i.amount) - num(i.paidAmount)), 0);

  const entitledFees = totalPrincipal > 0
    ? Math.min(totalFees, (totalFees * Math.max(0, totalPrincipal - futurePrincipal)) / totalPrincipal)
    : totalFees;

  const paidAmountAllInstallments = sorted.reduce((acc, i) => acc + num(i.paidAmount), 0);
  const feesCollected = Math.max(0, num(loan.repaidAmount) - paidAmountAllInstallments);
  const feesRemaining = Math.max(0, roundCurrency(entitledFees - feesCollected));

  // Split for display/ledger allocation, proportional to each component.
  const serviceFeeDue = totalFees > 0 ? roundCurrency((feesRemaining * num(totals.serviceFee)) / totalFees) : 0;
  const interestDue = totalFees > 0 ? roundCurrency((feesRemaining * num(totals.interest)) / totalFees) : 0;
  const taxDue = Math.max(0, roundCurrency(feesRemaining - serviceFeeDue - interestDue));

  const total = roundCurrency(principalRemaining + penaltyRemaining + feesRemaining);

  return {
    installmentId: active.id,
    installmentNumber: active.installmentNumber,
    principalRemaining,
    penaltyRemaining,
    penaltyForInstallment: roundCurrency(penaltyForInstallment),
    serviceFeeDue,
    interestDue,
    taxDue,
    total,
  };
}

/**
 * Amount due on a loan without an installment schedule (or once every
 * installment is settled): total repayable as of the date minus what has
 * been received.
 */
export function computeLoanLevelDue(
  loan: LoanDueContext,
  product: unknown,
  taxConfigs: Tax[],
  asOfDate: Date,
): number {
  const totals = calculateTotalRepayable(loan as never, product as never, taxConfigs ?? [], asOfDate);
  return Math.max(0, roundCurrency(totals.total - num(loan.repaidAmount)));
}
