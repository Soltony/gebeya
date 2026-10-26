/**
 * Wording for DirectPendingPayment (order payment) statuses, shared by the
 * Direct Payment report and the Pending Payments page. No server
 * dependencies, so client components can import it.
 */

type StatusCopy = { label: string; hint: string };

const STATUS_COPY: Record<string, StatusCopy> = {
  PENDING: { label: 'Not confirmed', hint: 'The bank has not confirmed it received the request.' },
  AWAITING_PIN: { label: 'Awaiting PIN', hint: 'Prompt sent to the customer; no result from the bank yet.' },
  PROCESSING: { label: 'Needs review', hint: 'The bank reported a failure that may still have moved money.' },
  FAILED: { label: 'Failed', hint: 'Declined by the customer or rejected by the bank.' },
  COMPLETED: { label: 'Paid', hint: 'Payment confirmed.' },
};

const GATEWAY_PENDING: StatusCopy = { label: 'Pending', hint: 'Sent to the super-app gateway; no confirmation yet.' };

export function directPaymentStatusCopy(status: string, method?: string | null): StatusCopy {
  const normalized = (status || '').toUpperCase();
  if (normalized === 'PENDING' && method !== 'USSD_PUSH') return GATEWAY_PENDING;
  return STATUS_COPY[normalized] ?? { label: status, hint: '' };
}

export function directPaymentMethodLabel(method: string | null | undefined): string {
  return method === 'USSD_PUSH' ? 'USSD push' : 'Super app';
}

/** Statuses whose money was never recorded, so an FT from the bank statement may still settle them. */
export const RESOLVABLE_DIRECT_PAYMENT_STATUSES = ['PENDING', 'AWAITING_PIN', 'PROCESSING', 'FAILED'];

export function isResolvableDirectPaymentStatus(status: string | null | undefined): boolean {
  return RESOLVABLE_DIRECT_PAYMENT_STATUSES.includes((status ?? '').toUpperCase());
}

/** Filters of the order-payments view, in display order. */
export const DIRECT_PAYMENT_FILTERS = [
  { key: 'OPEN', label: 'Awaiting confirmation', statuses: ['PENDING', 'AWAITING_PIN'] },
  { key: 'PROCESSING', label: 'Needs review', statuses: ['PROCESSING'] },
  { key: 'FAILED', label: 'Failed', statuses: ['FAILED'] },
  { key: 'COMPLETED', label: 'Paid', statuses: ['COMPLETED'] },
] as const;

export type DirectPaymentFilterKey = (typeof DIRECT_PAYMENT_FILTERS)[number]['key'];

export function directPaymentFilter(key: string | null | undefined) {
  return DIRECT_PAYMENT_FILTERS.find(f => f.key === (key ?? '').toUpperCase()) ?? DIRECT_PAYMENT_FILTERS[0];
}
