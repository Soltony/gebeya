/**
 * Telegram marketplace orders. Pricing is the shared marketplace pricing used
 * by the super app; this module adds the Telegram channel rules:
 *
 * - Direct (non-credit) orders only, so only DIRECT_ONLY and BOTH items.
 * - One merchant per order, every option group answered, quantities bounded.
 * - Nothing is charged when the order is placed. The customer pays on
 *   delivery with a NIB USSD push (./payments), which marks it DELIVERED.
 */
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { OrderPricingError, priceOrderItems, toOrderItemsCreate, type PricedOrder } from '@/lib/marketplace/order-pricing';
import { CUSTOMER_CANCELLABLE_STATUSES } from '@/lib/marketplace/order-status';
import { isNibPushEnabled } from '@/lib/nib-push/config';
import { PAYMENT_CANCEL_BLOCK_MINUTES, summarizeTelegramPayment } from './payment-summary';

export const TELEGRAM_CHANNEL = 'TELEGRAM';
export const TELEGRAM_ORDERABLE_SELLING_OPTIONS = ['DIRECT_ONLY', 'BOTH'];
export const MAX_LINE_QUANTITY = 99;
const MAX_LINES = 20;

export function isTelegramOrderable(item: { sellingOption?: string | null }): boolean {
  return TELEGRAM_ORDERABLE_SELLING_OPTIONS.includes(item.sellingOption || 'BNPL_ONLY');
}

export const telegramCartSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().min(1).max(64),
        variantId: z.string().min(1).max(64).nullish(),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
        optionSelections: z.array(z.object({ optionValueId: z.string().min(1).max(64) })).max(50).default([]),
      }),
    )
    .min(1)
    .max(MAX_LINES),
});

export type TelegramCart = z.infer<typeof telegramCartSchema>;

export class TelegramOrderError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Checks a priced cart against the Telegram channel rules. Pricing silently
 * ignores unknown variants and option values (the super app relies on that),
 * so the raw cart is checked here as well. Returns the order's merchant id.
 */
export function assertTelegramOrderRules(cart: TelegramCart, priced: PricedOrder): string {
  const merchantIds = new Set(priced.lines.map(line => line.item.merchantId));
  if (merchantIds.size !== 1) {
    throw new TelegramOrderError(400, 'Items from different merchants must be ordered separately.');
  }

  cart.items.forEach((input, index) => {
    const { item } = priced.lines[index];

    if (item.merchant?.status !== 'ACTIVE') {
      throw new TelegramOrderError(400, `${item.name} is not available right now.`);
    }
    if (!isTelegramOrderable(item)) {
      throw new TelegramOrderError(400, `${item.name} is only available with pay-later in the Nib app.`);
    }

    if (input.variantId && !item.variants.some(v => v.id === input.variantId && v.status === 'ACTIVE')) {
      throw new TelegramOrderError(400, `The selected version of ${item.name} is no longer available.`);
    }

    const activeGroups = item.optionGroups.filter(g => g.status === 'ACTIVE');
    const answered = new Set<string>();
    for (const { optionValueId } of input.optionSelections) {
      const group = activeGroups.find(g => g.values.some(v => v.id === optionValueId && v.status === 'ACTIVE'));
      if (!group) {
        throw new TelegramOrderError(400, `An option selected for ${item.name} is no longer available.`);
      }
      if (answered.has(group.id)) {
        throw new TelegramOrderError(400, `Choose one ${group.name} for ${item.name}.`);
      }
      answered.add(group.id);
    }
    const missing = activeGroups.find(g => g.values.some(v => v.status === 'ACTIVE') && !answered.has(g.id));
    if (missing) {
      throw new TelegramOrderError(400, `Choose a ${missing.name} for ${item.name}.`);
    }
  });

  return [...merchantIds][0];
}

async function priceTelegramCart(cart: TelegramCart) {
  let priced: PricedOrder;
  try {
    priced = await priceOrderItems(cart.items);
  } catch (error) {
    if (error instanceof OrderPricingError) throw new TelegramOrderError(400, 'One of the items is no longer available.');
    throw error;
  }
  const merchantId = assertTelegramOrderRules(cart, priced);
  return { priced, merchantId };
}

export type TelegramOrderQuote = Awaited<ReturnType<typeof quoteTelegramOrder>>;

/** The authoritative total for a cart, as it would be charged. */
export async function quoteTelegramOrder(cart: TelegramCart) {
  const { priced, merchantId } = await priceTelegramCart(cart);
  const merchant = priced.lines[0].item.merchant;
  return {
    merchant: { id: merchantId, name: merchant?.name ?? '' },
    lines: priced.lines.map(line => ({
      itemId: line.itemId,
      name: line.item.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: line.discountAmount,
      lineTotal: line.lineTotal,
    })),
    totalAmount: priced.totalAmount,
    currency: priced.lines[0].item.currency || 'ETB',
    requiresMerchantConfirmation: priced.requiresConfirmation,
  };
}

export async function createTelegramOrder(
  customer: { borrowerId: string; telegramUserId: string },
  cart: TelegramCart,
) {
  const { priced, merchantId } = await priceTelegramCart(cart);

  await prisma.borrower.upsert({
    where: { id: customer.borrowerId },
    update: {},
    create: { id: customer.borrowerId },
  });

  const order = await prisma.order.create({
    data: {
      borrowerId: customer.borrowerId,
      merchantId,
      totalAmount: priced.totalAmount,
      currency: priced.lines[0].item.currency || 'ETB',
      paymentType: 'DIRECT',
      channel: TELEGRAM_CHANNEL,
      status: priced.requiresConfirmation ? 'PENDING_MERCHANT_CONFIRMATION' : 'ON_DELIVERY',
      orderItems: { create: toOrderItemsCreate(priced) },
    },
    select: { id: true, status: true, totalAmount: true, currency: true },
  });

  await createAuditLog({
    actorId: customer.borrowerId,
    action: 'TELEGRAM_ORDER_CREATED',
    entity: 'ORDER',
    entityId: order.id,
    details: { telegramUserId: customer.telegramUserId, merchantId, totalAmount: order.totalAmount, lines: priced.lines.length },
  });

  return order;
}

const customerOrderSelect = {
  id: true,
  borrowerId: true,
  status: true,
  paymentType: true,
  totalAmount: true,
  currency: true,
  cancelReason: true,
  cancelledBy: true,
  createdAt: true,
  updatedAt: true,
  // accountNumber only decides whether the order can be paid; it is not sent to the Mini App.
  merchant: { select: { id: true, name: true, contactPersonName: true, contactPersonPhone: true, accountNumber: true } },
  orderItems: {
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      // No imageUrl: it holds base64 photos, and order screens and bot replies show none.
      item: { select: { id: true, name: true } },
      variant: { select: { name: true } },
      optionSelections: { select: { optionValue: { select: { label: true, group: { select: { name: true } } } } } },
    },
  },
  // Never the attempt's sharedSecret.
  directPendingPayments: {
    select: {
      status: true,
      statusDesc: true,
      amount: true,
      createdAt: true,
      completedAt: true,
      ft: { select: { cbsReference: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  },
} as const;

type CustomerOrderRow = Prisma.OrderGetPayload<{ select: typeof customerOrderSelect }>;

/** Replaces the raw payment attempts with what the customer needs to know about paying. */
function toCustomerOrder({ directPendingPayments, borrowerId, merchant, ...order }: CustomerOrderRow, enabled: boolean) {
  const { accountNumber, ...merchantContact } = merchant;
  return {
    ...order,
    merchant: merchantContact,
    payment: summarizeTelegramPayment({ status: order.status, totalAmount: order.totalAmount, borrowerId }, directPendingPayments, {
      enabled,
      merchantCanReceive: Boolean(accountNumber?.trim()),
    }),
  };
}

export type TelegramCustomerOrder = ReturnType<typeof toCustomerOrder>;

export async function listTelegramOrders(borrowerId: string, take = 50) {
  const orders = await prisma.order.findMany({
    where: { borrowerId, channel: TELEGRAM_CHANNEL },
    select: customerOrderSelect,
    orderBy: { createdAt: 'desc' },
    take,
  });
  const enabled = isNibPushEnabled();
  return orders.map(order => toCustomerOrder(order, enabled));
}

/** The order, or null when it does not exist or is not this customer's Telegram order. */
export async function getTelegramOrder(borrowerId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, borrowerId, channel: TELEGRAM_CHANNEL },
    select: customerOrderSelect,
  });
  return order ? toCustomerOrder(order, isNibPushEnabled()) : null;
}

export async function cancelTelegramOrder(customer: { borrowerId: string; telegramUserId: string }, orderId: string, reason: string) {
  // A prompt the customer may still approve, or a payment the bank is still
  // confirming, would leave money on a cancelled order.
  const paymentInProgress = await prisma.directPendingPayment.findFirst({
    where: {
      orderId,
      borrowerId: customer.borrowerId,
      OR: [
        { status: 'PROCESSING' },
        { status: { in: ['PENDING', 'AWAITING_PIN'] }, createdAt: { gt: new Date(Date.now() - PAYMENT_CANCEL_BLOCK_MINUTES * 60 * 1000) } },
      ],
    },
    select: { id: true },
  });
  if (paymentInProgress) {
    throw new TelegramOrderError(409, 'A payment for this order is in progress. Please wait for it to finish before cancelling.');
  }

  // Conditional update so a merchant status change in between cannot be overwritten.
  const { count } = await prisma.order.updateMany({
    where: {
      id: orderId,
      borrowerId: customer.borrowerId,
      channel: TELEGRAM_CHANNEL,
      status: { in: CUSTOMER_CANCELLABLE_STATUSES },
    },
    data: { status: 'CANCELLED', cancelReason: reason, cancelledBy: 'BORROWER' },
  });

  if (count === 0) {
    const existing = await getTelegramOrder(customer.borrowerId, orderId);
    if (!existing) throw new TelegramOrderError(404, 'Order not found.');
    throw new TelegramOrderError(409, `This order is already ${existing.status === 'DELIVERED' ? 'delivered' : 'cancelled'}.`);
  }

  await createAuditLog({
    actorId: customer.borrowerId,
    action: 'TELEGRAM_ORDER_CANCELLED',
    entity: 'ORDER',
    entityId: orderId,
    details: { telegramUserId: customer.telegramUserId, reason },
  });
}
