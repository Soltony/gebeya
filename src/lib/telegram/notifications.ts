/**
 * Order updates pushed to customers through the bot. Every function here is
 * best-effort: it logs and returns instead of throwing, so a Telegram outage
 * never fails the order operation that triggered it.
 */
import prisma from '@/lib/prisma';
import { sendMessage, TelegramApiError } from './bot-api';
import { isTelegramEnabled } from './config';
import { setBotBlocked } from './identity';
import { openAppKeyboard, orderNotificationText } from './messages';
import { TELEGRAM_CHANNEL } from './orders';

export async function notifyTelegramOrderUpdate(orderId: string, event: 'CREATED' | 'STATUS_CHANGED') {
  if (!isTelegramEnabled()) return;

  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        channel: true,
        borrowerId: true,
        totalAmount: true,
        cancelReason: true,
        merchant: { select: { name: true } },
        orderItems: { select: { quantity: true, item: { select: { name: true } } } },
      },
    });
    if (!order || order.channel !== TELEGRAM_CHANNEL) return;

    const recipients = await prisma.telegramUser.findMany({
      where: { borrowerId: order.borrowerId, chatId: { not: null }, botBlockedAt: null },
      select: { chatId: true },
    });

    const text = orderNotificationText(order, event);
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
          console.error('[telegram] order notification failed', { orderId, event, error: String(error) });
        }
      }
    }
  } catch (error) {
    console.error('[telegram] order notification failed', { orderId, event, error: String(error) });
  }
}
