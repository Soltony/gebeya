/**
 * Paying for Telegram orders with a NIB USSD push. As with direct payments in
 * the super app, the customer pays when the order arrives (ON_DELIVERY) and
 * the confirmed payment marks the order DELIVERED. The prompt goes to the
 * phone linked to the Telegram account, which Telegram itself verified, and
 * the money goes straight to the merchant's NIB account (guide §10.3,
 * dynamic routing).
 */
import prisma from '@/lib/prisma';
import { orderRef } from '@/lib/marketplace/order-status';
import { isNibPushEnabled, NibPushConfigError } from '@/lib/nib-push/config';
import { NibPushHttpError, NibPushNetworkError } from '@/lib/nib-push/client';
import { NibPushCryptoError } from '@/lib/nib-push/crypto';
import {
  OPEN_PUSH_STATUSES,
  PUSH_METHOD,
  PUSH_STATUS_CHECK_SELECT,
  PushStatus,
  refreshPushStatus,
  startPushPayment,
  type PushTransition,
} from '@/lib/nib-push/push-payments';
import { BRAND_NAME } from './messages';
import { TELEGRAM_CHANNEL, TelegramOrderError } from './orders';
import { PAYMENT_RESEND_AFTER_SECONDS } from './payment-summary';
import { maskPhone } from './phone';

const UNAVAILABLE = 'Paying in Telegram is not available right now. Please try again later.';
const MERCHANT_NOT_SET_UP = "This merchant can't take payments in Telegram yet. Please arrange payment with the merchant.";

// Stops a double-tapped Pay button from sending two prompts. Per process, like
// the rate limiter; the resend window below covers requests that get past it.
const inFlight = new Set<string>();


/**
 * Sends a payment prompt for the order to the customer's phone. Call
 * refreshTelegramOrderPayment first, so a resend never charges twice for a
 * prompt that was approved while its callback was late.
 */
export async function payTelegramOrder(
  customer: { borrowerId: string; telegramUserId: string },
  orderId: string,
  request: { ipAddress?: string; userAgent?: string },
): Promise<void> {
  if (!isNibPushEnabled()) throw new TelegramOrderError(503, UNAVAILABLE);
  if (inFlight.has(orderId)) throw new TelegramOrderError(409, 'Your payment prompt is already being sent.');
  inFlight.add(orderId);

  try {
    const order = await prisma.order.findFirst({
      where: { id: orderId, borrowerId: customer.borrowerId, channel: TELEGRAM_CHANNEL },
      select: {
        id: true,
        status: true,
        paymentType: true,
        totalAmount: true,
        merchantId: true,
        merchant: { select: { name: true, accountNumber: true } },
      },
    });
    if (!order) throw new TelegramOrderError(404, 'Order not found.');

    const attempts = await prisma.directPendingPayment.findMany({
      where: { orderId },
      select: { status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    if (attempts.some(a => a.status === PushStatus.COMPLETED)) throw new TelegramOrderError(409, 'This order is already paid.');
    if (attempts.some(a => a.status === PushStatus.PROCESSING)) {
      throw new TelegramOrderError(409, "The bank is still confirming your last payment. Please don't pay again.");
    }

    if (order.paymentType !== 'DIRECT') throw new TelegramOrderError(400, 'This order is not paid in Telegram.');
    if (order.status === 'PENDING_MERCHANT_CONFIRMATION') {
      throw new TelegramOrderError(409, 'You can pay once the merchant confirms your order.');
    }
    if (order.status === 'CANCELLED') throw new TelegramOrderError(409, 'This order was cancelled.');
    if (order.status !== 'ON_DELIVERY') throw new TelegramOrderError(409, 'This order is already delivered.');

    const latest = attempts[0];
    if (latest && OPEN_PUSH_STATUSES.includes(latest.status)) {
      const waitSeconds = Math.ceil(PAYMENT_RESEND_AFTER_SECONDS - (Date.now() - latest.createdAt.getTime()) / 1000);
      if (waitSeconds > 0) {
        throw new TelegramOrderError(409, `A payment prompt was just sent to your phone. If it didn't arrive, you can resend it in ${waitSeconds} seconds.`);
      }
    }

    const creditAccount = order.merchant?.accountNumber?.trim();
    if (!creditAccount) {
      console.error('[telegram-pay] merchant has no account number to credit', { orderId, merchantId: order.merchantId });
      throw new TelegramOrderError(409, MERCHANT_NOT_SET_UP);
    }

    let result;
    try {
      result = await startPushPayment({
        orderId: order.id,
        borrowerId: customer.borrowerId,
        merchantId: order.merchantId,
        amount: order.totalAmount,
        customerPhone: customer.borrowerId,
        creditAccount,
        merchantName: order.merchant?.name || BRAND_NAME,
        description: `Order ${orderRef(order.id)}`,
        request,
      });
    } catch (error) {
      if (error instanceof NibPushConfigError) {
        console.error('[telegram-pay] NIB push is misconfigured:', error.message);
        throw new TelegramOrderError(503, UNAVAILABLE);
      }
      if (error instanceof NibPushNetworkError || error instanceof NibPushHttpError || error instanceof NibPushCryptoError) {
        console.error('[telegram-pay] could not start the push', { orderId, error: error.message });
        throw new TelegramOrderError(502, "We couldn't reach the bank. Please try again in a moment.");
      }
      throw error;
    }

    if (result.status === 'FAILED') {
      if (/user not found/i.test(result.message)) {
        throw new TelegramOrderError(
          422,
          `Your number ${maskPhone(customer.borrowerId)} isn't registered with NIB International Bank, so it can't receive a payment prompt. Please arrange payment with the merchant.`,
        );
      }
      throw new TelegramOrderError(502, `The bank couldn't send the payment prompt: ${result.message}`);
    }
  } finally {
    inFlight.delete(orderId);
  }
}

/**
 * Checks the bank for the order's unfinished USSD push attempts (at most once
 * every 10 seconds each). Called while the Mini App waits for the PIN and
 * before a prompt is resent. Returns what changed, for notifications.
 */
export async function refreshTelegramOrderPayment(borrowerId: string, orderId: string): Promise<PushTransition[]> {
  const attempts = await prisma.directPendingPayment.findMany({
    where: {
      orderId,
      borrowerId,
      method: PUSH_METHOD,
      status: { in: [...OPEN_PUSH_STATUSES, PushStatus.PROCESSING] },
      order: { channel: TELEGRAM_CHANNEL },
    },
    select: PUSH_STATUS_CHECK_SELECT,
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  const transitions: PushTransition[] = [];
  for (const attempt of attempts) {
    const transition = await refreshPushStatus(attempt);
    if (transition) transitions.push(transition);
  }
  return transitions;
}
