/**
 * Canonical LoanInstallment status values.
 *
 * The database (SQL Server, case-insensitive collation) historically holds
 * mixed-case values ('Paid', 'Merged', 'Pending', 'Overdue') while some code
 * compared against uppercase ('PAID', 'MERGED') — JavaScript comparisons are
 * case-SENSITIVE, so paid installments were treated as unpaid and merged away.
 *
 * All writes must use these constants; all reads must use the helpers below.
 */
export const INSTALLMENT_STATUS = {
  Paid: 'Paid',
  Merged: 'Merged',
  Pending: 'Pending',
  Overdue: 'Overdue',
} as const;

/** Values a settled (non-payable) installment may hold, for DB `notIn` filters.
 *  SQL Server compares these case-insensitively; JS code must use the helpers. */
export const SETTLED_STATUSES: string[] = [INSTALLMENT_STATUS.Paid, INSTALLMENT_STATUS.Merged];

export function isPaidStatus(status: string | null | undefined): boolean {
  return (status ?? '').toLowerCase() === 'paid';
}

export function isMergedStatus(status: string | null | undefined): boolean {
  return (status ?? '').toLowerCase() === 'merged';
}

/** True when the installment can no longer receive payments. */
export function isSettledStatus(status: string | null | undefined): boolean {
  return isPaidStatus(status) || isMergedStatus(status);
}
