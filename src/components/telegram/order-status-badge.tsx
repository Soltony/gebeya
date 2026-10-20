import { orderStatusCopy } from '@/lib/marketplace/order-status';

const STATUS_CLASSES: Record<string, string> = {
  PENDING_MERCHANT_CONFIRMATION: 'bg-amber-100 text-amber-800',
  ON_DELIVERY: 'bg-blue-100 text-blue-800',
  DELIVERED: 'bg-green-100 text-green-800',
  CANCELLED: 'bg-red-100 text-red-800',
};

export function OrderStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASSES[status] ?? 'bg-gray-100 text-gray-800'}`}>
      {orderStatusCopy(status).label}
    </span>
  );
}
