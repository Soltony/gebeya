/**
 * Manual repayment recording — shared domain rules.
 *
 * A manual repayment is money the customer already handed over off-channel (cash
 * at a branch, a transfer, a cheque). The Maker keys it in, a Checker approves it,
 * and only the approval posts it against the loan.
 *
 * Posting itself is NOT implemented here. It goes through `applyBnplRepayment`,
 * the same pipeline the gateway callback and the pending-payment resolution use,
 * so a branch-recorded repayment moves the same amounts through the same ledger
 * accounts as every other channel. Two consequences follow from reusing it, and
 * both are deliberate:
 *
 *  - The allocation order (penalty -> service fee -> interest -> tax -> principal)
 *    belongs to that engine and is not configurable here. Making it configurable
 *    would mean forking the waterfall, which is the one thing worth avoiding.
 *  - An amount above what is owed is refused outright: `applyBnplRepayment`
 *    returns OVERPAYMENT having written nothing. There is no "post what fits"
 *    mode, so the Maker is told the payable figure up front instead.
 */

import type { Prisma } from '@prisma/client';
import { calculateTotalRepayable } from './loan-calculator';
import { computeActiveInstallmentDue, computeLoanLevelDue, MONEY_EPSILON } from './repayment-due';
import { roundCurrency } from './interest-accrual';

// --------------------------------------
// Vocabulary
// --------------------------------------

export const PAYMENT_SOURCES = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER_CHANNEL'] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

export const PAYMENT_SOURCE_LABELS: Record<PaymentSource, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank Transfer',
  CHEQUE: 'Cheque',
  OTHER_CHANNEL: 'Other Channel',
};

export const MANUAL_REPAYMENT_STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'PENDING_REVERSAL',
  'REVERSED',
] as const;
export type ManualRepaymentStatus = (typeof MANUAL_REPAYMENT_STATUSES)[number];

export const MANUAL_REPAYMENT_STATUS_LABELS: Record<ManualRepaymentStatus, string> = {
  PENDING_APPROVAL: 'Pending Approval',
  APPROVED: 'Posted',
  REJECTED: 'Rejected',
  PENDING_REVERSAL: 'Reversal Pending',
  REVERSED: 'Reversed',
};

/** The buckets a repayment settles, in the order `applyBnplRepayment` settles them. */
export const ALLOCATION_BUCKETS = ['PENALTY', 'SERVICE_FEE', 'INTEREST', 'TAX', 'PRINCIPAL'] as const;
export type AllocationBucket = (typeof ALLOCATION_BUCKETS)[number];

export const BUCKET_LABELS: Record<AllocationBucket, string> = {
  PENALTY: 'Penalty',
  SERVICE_FEE: 'Service Fee',
  INTEREST: 'Interest',
  TAX: 'Tax',
  PRINCIPAL: 'Principal',
};

/** Attachments are stored base64 on the row; keep them inside NVARCHAR(MAX). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** Repayments are not accepted against a loan in these states. */
export const CLOSED_LOAN_STATUSES = ['Paid', 'PAID', 'Closed', 'CLOSED', 'Reversed', 'REVERSED'];

/** Statuses that still hold a claim on their reference number. */
export const LIVE_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PENDING_REVERSAL'];

// --------------------------------------
// Configuration
// --------------------------------------

export interface ManualRepaymentPolicy {
  /** Repayments above this amount are refused at entry; null means no ceiling. */
  makerApprovalLimit: number | null;
  requireAttachment: boolean;
  notifyCustomer: boolean;
}

export const DEFAULT_POLICY: ManualRepaymentPolicy = {
  makerApprovalLimit: null,
  requireAttachment: false,
  notifyCustomer: true,
};

type ConfigRow = {
  makerApprovalLimit: number | null;
  requireAttachment: boolean;
  notifyCustomer: boolean;
} | null;

export function toPolicy(row: ConfigRow): ManualRepaymentPolicy {
  if (!row) return DEFAULT_POLICY;
  const limit = Number(row.makerApprovalLimit);
  return {
    makerApprovalLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    requireAttachment: !!row.requireAttachment,
    notifyCustomer: !!row.notifyCustomer,
  };
}

/** Reads the single-row policy, falling back to defaults when it is not set up. */
export async function getManualRepaymentPolicy(
  db: Pick<Prisma.TransactionClient, 'manualRepaymentConfig'>,
): Promise<ManualRepaymentPolicy> {
  const row = await db.manualRepaymentConfig.findUnique({ where: { id: 'global' } });
  return toPolicy(row as ConfigRow);
}

// --------------------------------------
// Reference numbers
// --------------------------------------

/**
 * The unique key behind "a reference number is unique within each payment source".
 *
 * Live rows (pending, posted, awaiting reversal) key on source + reference, so a
 * second entry of the same slip collides at the database. A rejected or reversed
 * row is re-keyed with its own id appended: the money never reached the loan, and
 * the branch must be able to re-submit the same genuine bank reference.
 */
export function activeReferenceKey(paymentSource: string, referenceNumber: string) {
  return `${paymentSource.toUpperCase()}|${normalizeReference(referenceNumber)}`;
}

export function retiredReferenceKey(paymentSource: string, referenceNumber: string, id: string) {
  return `${activeReferenceKey(paymentSource, referenceNumber)}|${id}`;
}

/** References compare case- and whitespace-insensitively; "ft 123" is "FT123". */
export function normalizeReference(input: string | null | undefined) {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

export function isValidPaymentSource(value: unknown): value is PaymentSource {
  return (PAYMENT_SOURCES as readonly string[]).includes(String(value));
}

// --------------------------------------
// What the loan owes
// --------------------------------------

export interface LoanBalanceSnapshot {
  principal: number;
  interest: number;
  serviceFee: number;
  penalty: number;
  tax: number;
  /** Everything the loan still owes, across all installments. */
  total: number;
  /**
   * What a single repayment may settle right now. For a loan on a schedule this
   * is the ACTIVE installment's quote, because `applyBnplRepayment` refuses
   * anything above it; for a loan without one it equals `total`.
   */
  payableNow: number;
  /** The installment the quote belongs to, or null when there is no schedule. */
  installmentNumber: number | null;
}

type LoanLike = {
  loanAmount: number;
  repaidAmount?: number | null;
  dueDate: Date | string;
  disbursedDate: Date | string;
  payments?: unknown;
};

/**
 * The quote the Maker is shown and the amount the Checker is re-checked against.
 *
 * `payableNow` is deliberately the same figure `applyBnplRepayment` will guard
 * with, so a repayment accepted at entry is not refused at approval for being a
 * cent over an installment nobody mentioned.
 */
export function loanBalanceSnapshot(
  loan: LoanLike,
  product: unknown,
  taxConfigs: unknown[],
  installments: Parameters<typeof computeActiveInstallmentDue>[3],
  asOfDate: Date,
): LoanBalanceSnapshot {
  const total = computeLoanLevelDue(loan as never, product, taxConfigs as never, asOfDate);

  const active = installments?.length
    ? computeActiveInstallmentDue(loan as never, product, taxConfigs as never, installments, asOfDate)
    : null;

  if (active) {
    return {
      principal: active.principalRemaining,
      penalty: active.penaltyRemaining,
      serviceFee: active.serviceFeeDue,
      interest: active.interestDue,
      tax: active.taxDue,
      total,
      payableNow: active.total,
      installmentNumber: active.installmentNumber,
    };
  }

  // No schedule (or every installment settled): split the loan-level balance the
  // way the waterfall will consume it, so the buckets shown add up to the total.
  const totals = calculateTotalRepayable(loan as never, product as never, (taxConfigs ?? []) as never, asOfDate);
  const buckets = splitAcrossBuckets(Math.max(0, roundCurrency(Number(loan.repaidAmount ?? 0))), {
    penalty: totals.penalty,
    serviceFee: totals.serviceFee,
    interest: totals.interest,
    tax: totals.tax,
    principal: totals.principal,
  });

  return {
    principal: roundCurrency(Math.max(0, totals.principal - buckets.principal)),
    interest: roundCurrency(Math.max(0, totals.interest - buckets.interest)),
    serviceFee: roundCurrency(Math.max(0, totals.serviceFee - buckets.serviceFee)),
    penalty: roundCurrency(Math.max(0, totals.penalty - buckets.penalty)),
    tax: roundCurrency(Math.max(0, totals.tax - buckets.tax)),
    total,
    payableNow: total,
    installmentNumber: null,
  };
}

/**
 * Consume `amount` across the buckets in the order `applyBnplRepayment` applies
 * them. The engine reports only its outcome, so this mirrors the split for the
 * audit trail and the "how it was applied" panel.
 */
export function splitAcrossBuckets(
  amount: number,
  buckets: { penalty: number; serviceFee: number; interest: number; tax: number; principal: number },
) {
  let remaining = Math.max(0, amount);
  const take = (due: number) => {
    const paid = Math.max(0, Math.min(remaining, Math.max(0, due)));
    remaining = roundCurrency(remaining - paid);
    return roundCurrency(paid);
  };
  return {
    penalty: take(buckets.penalty),
    serviceFee: take(buckets.serviceFee),
    interest: take(buckets.interest),
    tax: take(buckets.tax),
    principal: take(buckets.principal),
  };
}

/** The allocation a repayment of `amount` produces against a snapshot. */
export function allocationFor(amount: number, balance: LoanBalanceSnapshot) {
  const split = splitAcrossBuckets(amount, {
    penalty: balance.penalty,
    serviceFee: balance.serviceFee,
    interest: balance.interest,
    tax: balance.tax,
    principal: balance.principal,
  });
  return {
    PENALTY: split.penalty,
    SERVICE_FEE: split.serviceFee,
    INTEREST: split.interest,
    TAX: split.tax,
    PRINCIPAL: split.principal,
  } as Record<AllocationBucket, number>;
}

// --------------------------------------
// Entry validation
// --------------------------------------

export interface RepaymentEntryInput {
  amount: number;
  paymentSource: string;
  referenceNumber: string;
  paymentDate: Date;
  hasAttachment: boolean;
}

export interface ValidationContext {
  policy: ManualRepaymentPolicy;
  /** The figure `applyBnplRepayment` will guard with — see LoanBalanceSnapshot. */
  payableNow: number;
  loanRepaymentStatus: string;
  loanDisbursedDate: Date | string;
  /** End of the day the entry is being made; a payment cannot be dated after it. */
  today: Date;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateRepaymentEntry(
  input: RepaymentEntryInput,
  context: ValidationContext,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { policy, payableNow } = context;

  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    errors.push('Repayment amount must be greater than zero.');
  }

  if (!isValidPaymentSource(input.paymentSource)) {
    errors.push('Select a valid payment source.');
  }

  if (!normalizeReference(input.referenceNumber)) {
    errors.push('A transaction / reference number is required.');
  }

  if (CLOSED_LOAN_STATUSES.includes(context.loanRepaymentStatus)) {
    errors.push('This loan is already closed and cannot accept further repayments.');
  } else if (payableNow <= MONEY_EPSILON) {
    errors.push('This loan has nothing due to settle right now.');
  }

  if (!(input.paymentDate instanceof Date) || Number.isNaN(input.paymentDate.getTime())) {
    errors.push('Enter a valid payment date.');
  } else {
    if (input.paymentDate.getTime() > context.today.getTime()) {
      errors.push('The payment date cannot be in the future.');
    }
    if (input.paymentDate.getTime() < startOfDayMs(context.loanDisbursedDate)) {
      errors.push('The payment date cannot be before the loan was disbursed.');
    }
  }

  // The engine refuses an overpayment outright rather than posting what fits, so
  // this is an error in every case — there is no "warn and post" mode to offer.
  if (Number.isFinite(input.amount) && input.amount > payableNow + MONEY_EPSILON) {
    errors.push(
      `The amount (${formatBirr(input.amount)}) is more than the ${formatBirr(payableNow)} due now. ` +
        'Record exactly what is due, or split the payment.',
    );
  }

  if (
    policy.makerApprovalLimit != null &&
    Number.isFinite(input.amount) &&
    input.amount > policy.makerApprovalLimit + MONEY_EPSILON
  ) {
    errors.push(
      `The amount exceeds your approval limit of ${formatBirr(policy.makerApprovalLimit)}. ` +
        'Split the repayment or escalate it.',
    );
  }

  if (policy.requireAttachment && !input.hasAttachment) {
    errors.push('A receipt or bank slip must be attached.');
  }

  return { errors, warnings };
}

function startOfDayMs(value: Date | string) {
  const d = new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function formatBirr(amount: number) {
  return `${roundCurrency(Number(amount) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ETB`;
}

/** Status a loan lands in once a repayment settles. */
export function repaymentStatusLabel(outstandingAfter: number, repaidAnything: boolean) {
  if (outstandingAfter <= MONEY_EPSILON) return 'Fully Paid';
  return repaidAnything ? 'Partially Paid' : 'Unpaid';
}

export { MONEY_EPSILON };
