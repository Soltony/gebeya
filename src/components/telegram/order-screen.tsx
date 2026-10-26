'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Clock, Loader2, Package, Phone, ShoppingBag, Smartphone } from 'lucide-react';
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
import { useBackButton, useMainButton } from './use-telegram-buttons';
import { BackBar } from './back-bar';
import { OrderStatusBadge } from './order-status-badge';
import type { CustomerOrder } from './types';
import { PAYMENT_PROMPT_ANSWERED_SECONDS } from '@/lib/telegram/payment-summary';

const REFRESH_INTERVAL_MS = 20_000;
// While the customer answers the prompt; the server asks the bank at most every 10 s.
const PAYMENT_POLL_MS = 3_000;
// After that, until the bank reports back.
const PAYMENT_SLOW_POLL_MS = 15_000;
const PROCESSING_POLL_MS = 10_000;

/** True once the prompt has been out long enough to have been answered. */
function promptAnswered(promptSentAt: string | null): boolean {
  return Boolean(promptSentAt) && Date.now() - new Date(promptSentAt!).getTime() >= PAYMENT_PROMPT_ANSWERED_SECONDS * 1000;
}

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
  const [paying, setPaying] = useState(false);

  // After placing an order, "back" should not return to the checkout.
  const goBack = useCallback(() => {
    if (justPlaced || window.history.length <= 1) router.replace('/tg/orders');
    else router.back();
  }, [router, justPlaced]);
  const nativeBack = useBackButton(goBack);

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

  const refreshPayment = useCallback(() => {
    return api<{ order: CustomerOrder }>(`/api/tg/orders/${encodeURIComponent(orderId)}/pay`)
      .then(({ order }) => setOrder(order))
      .catch(() => {}); // The next poll tries again.
  }, [api, orderId]);

  const paymentState = order?.payment.state;
  const answered = paymentState === 'AWAITING_PIN' && promptAnswered(order?.payment.promptSentAt ?? null);
  useEffect(() => {
    if (paymentState !== 'AWAITING_PIN' && paymentState !== 'PROCESSING') return;
    const interval = paymentState === 'PROCESSING' ? PROCESSING_POLL_MS : answered ? PAYMENT_SLOW_POLL_MS : PAYMENT_POLL_MS;
    const timer = setInterval(refreshPayment, interval);
    return () => clearInterval(timer);
  }, [paymentState, answered, refreshPayment]);

  const previousPaymentState = useRef(paymentState);
  useEffect(() => {
    if (previousPaymentState.current === 'AWAITING_PIN' && paymentState === 'PAID') haptic('success');
    previousPaymentState.current = paymentState;
  }, [paymentState, haptic]);

  const pay = useCallback(async () => {
    if (!order || paying) return;
    const { payment } = order;
    const ok = await confirm(
      payment.state === 'AWAITING_PIN'
        ? `Only send a new prompt if you did NOT approve the last one.\n\n` +
            `If you already entered your PIN, the money has left your account: wait for the bank's confirmation instead, ` +
            `or you may pay twice.\n\nSend a new prompt to ${payment.phone}?`
        : `Pay ${formatEtb(payment.amount)} to ${order.merchant?.name ?? 'the merchant'} for order ${orderRef(order.id)}?\n\n` +
            `We'll send a prompt to ${payment.phone} — approve it with your PIN. Only pay once you have your items.`,
    );
    if (!ok) return;
    setPaying(true);
    try {
      const { order: updated } = await api<{ order: CustomerOrder }>(`/api/tg/orders/${encodeURIComponent(order.id)}/pay`, {
        method: 'POST',
      });
      setOrder(updated);
      haptic('success');
    } catch (e: any) {
      haptic('error');
      await alert(e?.message || 'Could not start the payment.');
      await load();
    } finally {
      setPaying(false);
    }
  }, [order, paying, confirm, api, haptic, alert, load]);

  // The big bottom button is only for paying; resending a prompt is a small
  // action on the payment card, so a customer who already paid is not urged
  // to pay again while the bank is slow to confirm.
  const canPay = Boolean(order?.payment.canPay) && paymentState === 'UNPAID';
  const canResend = Boolean(order?.payment.canPay) && paymentState === 'AWAITING_PIN';
  const payLabel = `Pay ${formatEtb(order?.payment.amount ?? 0)}`;
  const nativeMainButton = useMainButton({ text: payLabel, visible: canPay, progress: paying, onClick: pay });

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

  const backBar = <BackBar onBack={goBack} hidden={nativeBack} title={order ? `Order ${orderRef(order.id)}` : 'Order'} />;

  if (error) {
    return (
      <>
        {backBar}
        <p className="px-6 py-16 text-center text-sm tg-destructive">{error}</p>
        <OrderScreenLinks />
      </>
    );
  }
  if (!order) {
    return (
      <>
        {backBar}
        <div className="space-y-3 p-4">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </>
    );
  }

  const copy = orderStatusCopy(order.status);
  const paymentBusy = order.payment.state === 'AWAITING_PIN' || order.payment.state === 'PROCESSING';
  const cancellable = CUSTOMER_CANCELLABLE_STATUSES.includes(order.status as OrderStatus) && !paymentBusy;

  return (
    <>
    {backBar}
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

      <PaymentCard order={order} answered={answered} onResend={canResend ? pay : null} resending={paying} />

      {canPay && !nativeMainButton && (
        <Button className="tg-primary-button h-11 w-full rounded-xl font-semibold" onClick={pay} disabled={paying}>
          {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : payLabel}
        </Button>
      )}

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
    <OrderScreenLinks />
    </>
  );
}

/** Where paying for the order stands, and what the customer does next. */
function PaymentCard({
  order,
  answered,
  onResend,
  resending,
}: {
  order: CustomerOrder;
  /** The prompt has been out long enough to have been answered. */
  answered: boolean;
  onResend: (() => void) | null;
  resending: boolean;
}) {
  const { payment } = order;

  if (payment.state === 'PAID') {
    return (
      <div className="tg-section space-y-1 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-green-700">
          <Check className="h-4 w-4" />
          Paid {formatEtb(payment.amount)}
        </p>
        {payment.cbsReference && <p className="tg-hint">Bank reference {payment.cbsReference}</p>}
        {payment.paidAt && <p className="text-xs tg-hint">{new Date(payment.paidAt).toLocaleString()}</p>}
      </div>
    );
  }

  if (payment.state === 'PROCESSING') {
    return (
      <div className="tg-section space-y-1 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium">
          <Clock className="h-4 w-4" />
          Confirming your payment
        </p>
        <p className="tg-hint">The bank is confirming your payment. This can take a few minutes — please don't pay again.</p>
      </div>
    );
  }

  if (payment.state === 'AWAITING_PIN') {
    const resend = onResend && (
      <Button variant="outline" size="sm" className="mt-2 w-full rounded-xl" onClick={onResend} disabled={resending}>
        {resending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'I did not get a prompt, send a new one'}
      </Button>
    );

    if (answered) {
      // The customer may have paid; only the bank's confirmation can tell.
      return (
        <div className="tg-section space-y-1 p-4 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <Clock className="h-4 w-4" />
            Waiting for the bank to confirm
          </p>
          <p className="tg-hint">
            If you approved the {formatEtb(payment.amount)} payment, it will show here as soon as the bank confirms it, and
            we'll message you in this chat. Please don't pay again.
          </p>
          {payment.message && <p className="tg-hint">{payment.message}</p>}
          {resend}
        </div>
      );
    }

    return (
      <div className="tg-section space-y-1 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium">
          <Smartphone className="h-4 w-4" />
          Check your phone
          <Loader2 className="h-3.5 w-3.5 animate-spin tg-hint" />
        </p>
        <p className="tg-hint">
          Approve the {formatEtb(payment.amount)} payment prompt sent to {payment.phone} with your PIN.
        </p>
        {payment.message && <p className="tg-hint">{payment.message}</p>}
        {resend ?? <p className="text-xs tg-hint">Didn't get it? You can send a new one after a minute.</p>}
      </div>
    );
  }

  let text: string;
  if (order.status === 'CANCELLED') text = 'No payment was taken for this order.';
  else if (!payment.enabled) text = 'No payment has been taken for this order. Paying and confirming delivery in Telegram is coming soon.';
  else if (!payment.merchantCanReceive && order.status !== 'DELIVERED') {
    text = "This merchant can't take payments in Telegram yet. Please arrange payment with the merchant.";
  }
  else if (order.status === 'PENDING_MERCHANT_CONFIRMATION') {
    text = `You'll pay when your order arrives: we'll send a payment prompt to ${payment.phone}, and you approve it with your PIN.`;
  } else if (order.status === 'ON_DELIVERY') {
    text = `Pay when your order arrives. We'll send a payment prompt to ${payment.phone} — approve it with your PIN.`;
  } else text = 'No payment was taken in Telegram for this order.';

  return (
    <div className="tg-section space-y-1 p-4 text-sm">
      <p className="font-medium">Payment</p>
      <p className="tg-hint">{text}</p>
      {payment.message && order.status === 'ON_DELIVERY' && <p className="tg-destructive">Last attempt: {payment.message}</p>}
    </div>
  );
}

/** Ways out of an order screen, so it is never a dead end. */
function OrderScreenLinks() {
  return (
    <div className="flex gap-2 px-4 pb-4">
      <Link href="/tg" className="tg-chip flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-medium">
        <ShoppingBag className="h-4 w-4" />
        Continue shopping
      </Link>
      <Link href="/tg/orders" className="tg-chip flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-medium">
        <Package className="h-4 w-4" />
        My orders
      </Link>
    </div>
  );
}
