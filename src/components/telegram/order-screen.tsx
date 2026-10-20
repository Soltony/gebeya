'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  formatEtb,
  orderRef,
  orderStatusCopy,
  type OrderStatus,
} from '@/lib/marketplace/order-status';
import { useTelegram } from './telegram-provider';
import { useBackButton } from './use-telegram-buttons';
import { OrderStatusBadge } from './order-status-badge';
import type { CustomerOrder } from './types';

const REFRESH_INTERVAL_MS = 20_000;

const STEPS: Array<{ label: string; reachedAt: OrderStatus[] }> = [
  { label: 'Order placed', reachedAt: ['PENDING_MERCHANT_CONFIRMATION', 'ON_DELIVERY', 'DELIVERED'] },
  { label: 'Confirmed by merchant', reachedAt: ['ON_DELIVERY', 'DELIVERED'] },
  { label: 'Delivered', reachedAt: ['DELIVERED'] },
];

export function OrderScreen({ orderId, justPlaced }: { orderId: string; justPlaced: boolean }) {
  const router = useRouter();
  const { api, alert, confirm, haptic } = useTelegram();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // After placing an order, "back" should not return to the checkout.
  const goBack = useCallback(() => {
    if (justPlaced || window.history.length <= 1) router.replace('/tg/orders');
    else router.back();
  }, [router, justPlaced]);
  useBackButton(goBack);

  const load = useCallback(() => {
    return api<{ order: CustomerOrder }>(`/api/tg/orders/${encodeURIComponent(orderId)}`)
      .then(({ order }) => {
        setOrder(order);
        setError(null);
      })
      .catch(e => setError(e.message));
  }, [api, orderId]);

  const isFinal = order?.status === 'DELIVERED' || order?.status === 'CANCELLED';

  useEffect(() => {
    load();
  }, [load]);

  // Merchants update the status from the admin panel; keep the screen current while it is open.
  useEffect(() => {
    if (isFinal) return;
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, isFinal]);

  const cancel = async () => {
    if (!order) return;
    const ok = await confirm(`Cancel order ${orderRef(order.id)}?`);
    if (!ok) return;
    setCancelling(true);
    try {
      await api(`/api/tg/orders/${encodeURIComponent(order.id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Cancelled by customer' }),
      });
      haptic('success');
      await load();
    } catch (e: any) {
      haptic('error');
      await alert(e?.message || 'Could not cancel the order.');
      await load();
    } finally {
      setCancelling(false);
    }
  };

  if (error) return <p className="px-6 py-16 text-center text-sm tg-destructive">{error}</p>;
  if (!order) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    );
  }

  const copy = orderStatusCopy(order.status);
  const cancellable = CUSTOMER_CANCELLABLE_STATUSES.includes(order.status as OrderStatus);

  return (
    <div className="space-y-3 p-4">
      {justPlaced && order.status !== 'CANCELLED' && (
        <div className="tg-section border border-green-300 p-4 text-sm">
          <p className="font-semibold text-green-700">Order placed</p>
          <p className="mt-1 tg-hint">We'll message you in this chat whenever its status changes.</p>
        </div>
      )}

      <div className="tg-section space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-base font-semibold">Order {orderRef(order.id)}</span>
          <OrderStatusBadge status={order.status} />
        </div>
        <p className="text-sm tg-hint">{copy.description}</p>

        {order.status === 'CANCELLED' ? (
          <p className="text-sm">
            Cancelled by {order.cancelledBy === 'BORROWER' ? 'you' : 'the merchant'}
            {order.cancelReason ? ` — ${order.cancelReason}` : ''}
          </p>
        ) : (
          <ol className="space-y-2 pt-1">
            {STEPS.map(step => {
              const reached = step.reachedAt.includes(order.status as OrderStatus);
              return (
                <li key={step.label} className="flex items-center gap-2 text-sm">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full ${reached ? 'bg-green-500 text-white' : 'tg-chip'}`}
                  >
                    {reached && <Check className="h-3 w-3" />}
                  </span>
                  <span className={reached ? 'font-medium' : 'tg-hint'}>{step.label}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="tg-section divide-y tg-separator">
        {order.orderItems.map(line => (
          <div key={line.id} className="flex gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {line.quantity} × {line.item.name}
              </p>
              {(line.variant || line.optionSelections.length > 0) && (
                <p className="text-xs tg-hint">
                  {[line.variant?.name, ...line.optionSelections.map(s => `${s.optionValue.group.name}: ${s.optionValue.label}`)]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            <span className="shrink-0 text-sm">{formatEtb(line.lineTotal)}</span>
          </div>
        ))}
        <div className="flex justify-between p-4 text-base font-semibold">
          <span>Total</span>
          <span>{formatEtb(order.totalAmount)}</span>
        </div>
      </div>

      <div className="tg-section space-y-1 p-4 text-sm">
        <p className="font-medium">Payment</p>
        <p className="tg-hint">
          No payment has been taken for this order. Paying and confirming delivery in Telegram is coming soon.
        </p>
      </div>

      {order.merchant && (
        <div className="tg-section space-y-1 p-4 text-sm">
          <p className="font-medium">{order.merchant.name}</p>
          {order.merchant.contactPersonName && <p className="tg-hint">{order.merchant.contactPersonName}</p>}
          {order.merchant.contactPersonPhone && (
            <a href={`tel:${order.merchant.contactPersonPhone}`} className="inline-flex items-center gap-1.5 tg-link">
              <Phone className="h-4 w-4" />
              {order.merchant.contactPersonPhone}
            </a>
          )}
        </div>
      )}

      <p className="text-center text-xs tg-hint">Placed {new Date(order.createdAt).toLocaleString()}</p>

      {cancellable && (
        <Button variant="ghost" className="w-full tg-destructive" onClick={cancel} disabled={cancelling}>
          {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Cancel order'}
        </Button>
      )}
    </div>
  );
}
