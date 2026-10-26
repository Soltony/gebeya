/**
 * Text and keyboards the bot sends. Kept together so wording stays consistent
 * between command replies and order notifications.
 */
import { escapeHtml, type ReplyMarkup } from './bot-api';
import { getMiniAppUrl, getSupportText } from './config';
import { formatEtb, orderRef, orderStatusCopy } from '@/lib/marketplace/order-status';

export const BRAND_NAME = 'Gebeya';

/** Mini App URL for a path inside /tg, e.g. "/orders/abc". */
export function miniAppUrl(path = ''): string {
  return `${getMiniAppUrl()}${path}`;
}

export function openAppKeyboard(text = `🛍 Open ${BRAND_NAME}`, path = ''): ReplyMarkup {
  return { inline_keyboard: [[{ text, web_app: { url: miniAppUrl(path) } }]] };
}

export const shareContactKeyboard: ReplyMarkup = {
  keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
  input_field_placeholder: 'Tap the button below',
};

export function welcomeText(firstName?: string): string {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)}! ` : '';
  return (
    `${greeting}Welcome to <b>${BRAND_NAME}</b> 🛍\n\n` +
    'Browse products from verified merchants and order them right here in Telegram. ' +
    "You'll get a message here whenever your order status changes."
  );
}

export const askForPhoneText =
  'To place orders, please share your phone number. Merchants use it to arrange delivery, ' +
  'and it links your orders to you.';

export const phoneMismatchText = 'Please share <b>your own</b> number using the button below.';

export const unsupportedPhoneText =
  `${BRAND_NAME} currently supports Ethiopian mobile numbers (+251 9… or +251 7…) only.`;

export function phoneLinkedText(maskedPhone: string): string {
  return `✅ Your number <b>${escapeHtml(maskedPhone)}</b> is linked. You can now place orders — open the shop from the menu button.`;
}

export function helpText(): string {
  const support = getSupportText();
  return (
    `<b>${BRAND_NAME} bot</b>\n\n` +
    '/shop — browse products\n' +
    '/orders — your recent orders\n' +
    '/phone — link your phone number\n' +
    '/help — this message' +
    (support ? `\n\n${escapeHtml(support)}` : '')
  );
}

type OrderSummary = {
  id: string;
  status: string;
  totalAmount: number;
  merchant: { name: string } | null;
  orderItems: Array<{ quantity: number; item: { name: string } }>;
};

function describeItems(order: OrderSummary): string {
  const shown = order.orderItems.slice(0, 3).map(i => `${i.quantity} × ${escapeHtml(i.item.name)}`);
  const extra = order.orderItems.length - shown.length;
  return shown.join('\n') + (extra > 0 ? `\n+${extra} more` : '');
}

export function orderNotificationText(order: OrderSummary & { cancelReason?: string | null }, event: 'CREATED' | 'STATUS_CHANGED'): string {
  const copy = orderStatusCopy(order.status);
  const heading = event === 'CREATED' ? '🛍 <b>Order received</b>' : `${copy.emoji} <b>Order ${escapeHtml(copy.label.toLowerCase())}</b>`;
  const lines = [
    heading,
    `${orderRef(order.id)} · ${escapeHtml(order.merchant?.name ?? '')}`,
    '',
    describeItems(order),
    `Total: <b>${formatEtb(order.totalAmount)}</b>`,
    '',
    copy.description,
  ];
  if (order.status === 'CANCELLED' && order.cancelReason) lines.push(`Reason: ${escapeHtml(order.cancelReason)}`);
  return lines.join('\n');
}

type PaymentNotice = {
  to: 'COMPLETED' | 'FAILED' | 'PROCESSING';
  amount: number;
  statusDesc: string | null;
  cbsReference: string | null;
  orderDelivered: boolean;
};

export function paymentNotificationText(order: OrderSummary, payment: PaymentNotice): string {
  const heading = `${orderRef(order.id)} · ${escapeHtml(order.merchant?.name ?? '')}`;
  switch (payment.to) {
    case 'COMPLETED':
      return [
        '✅ <b>Payment received</b>',
        heading,
        '',
        `Paid: <b>${formatEtb(payment.amount)}</b>`,
        ...(payment.cbsReference ? [`Bank reference: <code>${escapeHtml(payment.cbsReference)}</code>`] : []),
        '',
        payment.orderDelivered ? 'Your order is now marked as delivered. Thank you!' : 'Thank you!',
      ].join('\n');
    case 'FAILED':
      return [
        '❌ <b>Payment not completed</b>',
        heading,
        '',
        escapeHtml(payment.statusDesc || 'The payment was not approved.'),
        '',
        'Open the order to try again.',
      ].join('\n');
    case 'PROCESSING':
      return [
        '🕒 <b>Confirming your payment</b>',
        heading,
        '',
        "The bank is confirming your payment. Please don't pay again — we'll update the order once it's confirmed.",
      ].join('\n');
  }
}

export function recentOrdersText(orders: OrderSummary[]): string {
  if (orders.length === 0) return "You haven't placed any orders yet.";
  const rows = orders.map(o => {
    const copy = orderStatusCopy(o.status);
    return `${copy.emoji} ${orderRef(o.id)} · ${escapeHtml(o.merchant?.name ?? '')} · ${formatEtb(o.totalAmount)} — ${escapeHtml(copy.label)}`;
  });
  return `<b>Your recent orders</b>\n\n${rows.join('\n')}`;
}
