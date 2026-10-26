/**
 * Order updates pushed to customers through the bot. Every function here is
 * best-effort: it logs and returns instead of throwing, so a Telegram outage
 * never fails the order operation that triggered it.
 */
import prisma from '@/lib/prisma';
import type { PushTransition } from '@/lib/nib-push/push-payments';
import { sendMessage, TelegramApiError } from './bot-api';
import { isTelegramEnabled } from './config';
import { setBotBlocked } from './identity';
import { openAppKeyboard, orderNotificationText, paymentNotificationText } from './messages';
import { TELEGRAM_CHANNEL } from './orders';

const orderSummarySelect = {
  id: true,
  status: true,
  channel: true,
  borrowerId: true,
  totalAmount: true,
  cancelReason: true,
  merchant: { select: { name: true } },
  orderItems: { select: { quantity: true, item: { select: { name: true } } } },
} as const;

/** Sends `text` to every chat linked to the customer's phone, with a button back to the order. */
async function sendToCustomer(order: { id: string; borrowerId: string }, text: string, logContext: Record<string, unknown>) {
  const recipients = await prisma.telegramUser.findMany({
    where: { borrowerId: order.borrowerId, chatId: { not: null }, botBlockedAt: null },
    select: { chatId: true },
  });

  for (const { chatId } of recipients) {
    try {
      await sendMessage({
        chat_id: chatId!,
        text,
        parse_mode: 'HTML',
        reply_markup: openAppKeyboard('View order', `/orders/${order.id}`),
      });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isUnreachableUser) {
        await setBotBlocked(chatId!, true);
      } else {
        console.error('[telegram] notification failed', { ...logContext, error: String(error) });
      }
    }
  }
}

export async function notifyTelegramOrderUpdate(orderId: string, event: 'CREATED' | 'STATUS_CHANGED') {
  if (!isTelegramEnabled()) return;

  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: orderSummarySelect });
    if (!order || order.channel !== TELEGRAM_CHANNEL) return;
    await sendToCustomer(order, orderNotificationText(order, event), { orderId, event });
  } catch (error) {
    console.error('[telegram] order notification failed', { orderId, event, error: String(error) });
  }
}

/** Tells the customer how a USSD push payment ended. */
export async function notifyTelegramPaymentUpdate(transition: PushTransition) {
  if (!isTelegramEnabled()) return;
  // Money the order did not need is handled by operations, not announced.
  if (transition.needsRefund) return;

  const logContext = { orderId: transition.orderId, payment: transition.to };
  try {
    const order = await prisma.order.findUnique({
      where: { id: transition.orderId },
      select: {
        ...orderSummarySelect,
        directPendingPayments: { select: { transactionId: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!order || order.channel !== TELEGRAM_CHANNEL) return;
    // A failed prompt the customer already replaced with a new one is not news.
    if (transition.to === 'FAILED' && order.directPendingPayments[0]?.transactionId !== transition.transactionRef) return;

    await sendToCustomer(order, paymentNotificationText(order, transition), logContext);
  } catch (error) {
    console.error('[telegram] payment notification failed', { ...logContext, error: String(error) });
  }
}
