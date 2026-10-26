'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEtb, orderRef } from '@/lib/marketplace/order-status';
import { TgApiError, useTelegram } from './telegram-provider';
import { useBackButton } from './use-telegram-buttons';
import { TgTabs } from './tg-tabs';
import { OrderStatusBadge } from './order-status-badge';
import type { CustomerOrder } from './types';

export function OrdersScreen() {
  const { api, me, linkPhone } = useTelegram();
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  useBackButton(null);

  const load = useCallback(() => {
    if (!me?.phoneLinked) return;
    api<{ orders: CustomerOrder[] }>('/api/tg/orders')
      .then(({ orders }) => {
        setOrders(orders);
        setError(null);
      })
      .catch(e => setError(e instanceof TgApiError ? e.message : 'Could not load your orders.'));
  }, [api, me?.phoneLinked]);

  useEffect(load, [load]);

  const startLink = async () => {
    setLinking(true);
    try {
      await linkPhone();
    } finally {
      setLinking(false);
    }
  };

  return (
    <div>
      <TgTabs />
      <div className="space-y-3 px-4">
        {!me?.phoneLinked ? (
          <div className="tg-section space-y-3 p-5 text-center">
            <p className="font-medium">Link your phone number</p>
            <p className="text-sm tg-hint">Your orders are linked to your phone number. Share it once to see and place orders.</p>
            <Button className="tg-primary-button w-full rounded-xl" onClick={startLink} disabled={linking}>
              {linking ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Share phone number'}
            </Button>
          </div>
        ) : error ? (
          <p className="py-10 text-center text-sm tg-destructive">{error}</p>
        ) : !orders ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-2xl" />)
        ) : orders.length === 0 ? (
          <div className="py-10 text-center text-sm tg-hint">
            <p>You haven't placed any orders yet.</p>
            <Link href="/tg" className="mt-2 inline-block font-medium tg-link">
              Browse the shop
            </Link>
          </div>
        ) : (
          orders.map(order => (
            <Link key={order.id} href={`/tg/orders/${order.id}`} className="tg-section flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{orderRef(order.id)}</span>
                  <OrderStatusBadge status={order.status} />
                </div>
                <p className="truncate text-sm">
                  {order.orderItems.map(i => `${i.quantity} × ${i.item.name}`).join(', ')}
                </p>
                <p className="text-xs tg-hint">
                  {order.merchant?.name} · {new Date(order.createdAt).toLocaleDateString()} · {formatEtb(order.totalAmount)}
                  {order.payment.state === 'PAID' ? ' · Paid' : ''}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 tg-hint" />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
