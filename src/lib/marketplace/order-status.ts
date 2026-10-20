/**
 * Customer-facing wording for order statuses. Safe to import from client
 * components (no server dependencies).
 */

export type OrderStatus = 'PENDING_MERCHANT_CONFIRMATION' | 'ON_DELIVERY' | 'DELIVERED' | 'CANCELLED';

type StatusCopy = { label: string; description: string; emoji: string };

const STATUS_COPY: Record<OrderStatus, StatusCopy> = {
  PENDING_MERCHANT_CONFIRMATION: {
    label: 'Waiting for merchant',
    description: 'The merchant is confirming your items are available.',
    emoji: '🕒',
  },
  ON_DELIVERY: {
    label: 'On the way',
    description: 'The merchant has confirmed your order and is arranging delivery.',
    emoji: '🚚',
  },
  DELIVERED: {
    label: 'Delivered',
    description: 'Your order has been delivered.',
    emoji: '✅',
  },
  CANCELLED: {
    label: 'Cancelled',
    description: 'This order was cancelled.',
    emoji: '✖️',
  },
};

export function orderStatusCopy(status: string): StatusCopy {
  return STATUS_COPY[status as OrderStatus] ?? { label: status, description: '', emoji: 'ℹ️' };
}

/** Statuses in which the customer may still cancel. */
export const CUSTOMER_CANCELLABLE_STATUSES: OrderStatus[] = ['PENDING_MERCHANT_CONFIRMATION', 'ON_DELIVERY'];

/** Short reference shown to customers and merchants, e.g. #4F9K2Q. */
export function orderRef(orderId: string): string {
  return `#${orderId.slice(-6).toUpperCase()}`;
}

export function formatEtb(amount: number): string {
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ETB`;
}
