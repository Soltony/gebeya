/**
 * Canonical PendingPayment status values and the rules about which of them an
 * operator may still resolve by hand.
 *
 * A payment intent is created when the borrower is sent to the gateway. It ends
 * up in one of four states:
 *
 *   PENDING   — sent to the gateway, no callback yet.
 *   COMPLETED — the callback arrived (or an operator resolved it) and the money
 *               is booked against the loan.
 *   FAILED    — the callback arrived but carried more money than was owed, so
 *               nothing was applied.
 *   EXPIRED   — no usable callback within the TTL, or swept by a data fix.
 *
 * Only COMPLETED means the money reached the loan. The other three are all
 * "the borrower may have been debited but we never booked it", which is exactly
 * what the manual FT-reference flow exists to correct — so all three are
 * resolvable. Resolving a COMPLETED intent would book the same money twice.
 */

export const PENDING_PAYMENT_STATUS = {
  Pending: 'PENDING',
  Completed: 'COMPLETED',
  Failed: 'FAILED',
  Expired: 'EXPIRED',
} as const;

/** Statuses the Pending Payments page can list, in the order shown in the UI. */
export const LISTABLE_PENDING_PAYMENT_STATUSES: string[] = [
  PENDING_PAYMENT_STATUS.Pending,
  PENDING_PAYMENT_STATUS.Expired,
  PENDING_PAYMENT_STATUS.Failed,
  PENDING_PAYMENT_STATUS.Completed,
];

/** Statuses whose money was never booked, so an FT reference may still settle them. */
export const RESOLVABLE_PENDING_PAYMENT_STATUSES: string[] = [
  PENDING_PAYMENT_STATUS.Pending,
  PENDING_PAYMENT_STATUS.Expired,
  PENDING_PAYMENT_STATUS.Failed,
];

/**
 * True when the intent can still be settled by hand. Compares case-insensitively
 * because SQL Server's collation lets mixed-case values into the column while
 * JavaScript comparisons would not match them.
 */
export function isResolvablePendingPaymentStatus(
  status: string | null | undefined
): boolean {
  const normalized = (status ?? '').toUpperCase();
  return RESOLVABLE_PENDING_PAYMENT_STATUSES.includes(normalized);
}

/** Normalises a requested status filter, falling back to PENDING. */
export function normalizePendingPaymentStatusFilter(
  status: string | null | undefined
): string {
  const normalized = (status ?? '').toUpperCase();
  return LISTABLE_PENDING_PAYMENT_STATUSES.includes(normalized)
    ? normalized
    : PENDING_PAYMENT_STATUS.Pending;
}
