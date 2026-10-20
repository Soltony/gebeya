/**
 * Server-side pricing of a marketplace order: unit price (variant + option
 * deltas), line totals and the best active discount per line. Shared by the
 * super-app order route (/api/bnpl/orders) and the Telegram Mini App so both
 * channels charge the same amount for the same basket.
 */
import prisma from '@/lib/prisma';
import { getDiscountEffectiveAmount, isDiscountActive, pickBestDiscount } from '@/lib/discount-utils';

export type OrderLineInput = {
  itemId: string;
  variantId?: string | null;
  quantity?: number;
  optionSelections?: Array<{ optionValueId: string }>;
};

export class OrderPricingError extends Error {}

async function loadItem(itemId: string) {
  return prisma.item.findUnique({
    where: { id: itemId },
    include: {
      merchant: { select: { id: true, name: true, status: true } },
      variants: true,
      optionGroups: { include: { values: true } },
    },
  });
}

export type PricedItem = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

export type PricedOrderLine = {
  itemId: string;
  variantId: string | null;
  quantity: number;
  unitPrice: number;
  /** After this line's discount. */
  lineTotal: number;
  discountAmount: number;
  optionSelections: Array<{ optionValueId: string; priceDelta: number }>;
  item: PricedItem;
};

export type PricedOrder = {
  lines: PricedOrderLine[];
  /** Sum of discounted line totals, never below zero. */
  totalAmount: number;
  /** True when any item needs the merchant to confirm stock before delivery. */
  requiresConfirmation: boolean;
};

/**
 * Prices the lines exactly as the order will be stored. Throws
 * OrderPricingError when an item is missing or inactive.
 */
export async function priceOrderItems(lines: OrderLineInput[]): Promise<PricedOrder> {
  let requiresConfirmation = false;
  let totalAmount = 0;
  const priced: PricedOrderLine[] = [];

  for (const orderItem of lines) {
    const item = await loadItem(orderItem.itemId);

    if (!item || item.status !== 'ACTIVE') {
      throw new OrderPricingError(`Item ${orderItem.itemId} not found or inactive`);
    }

    // If any item in the order needs the merchant to confirm stock, the whole
    // order waits for that confirmation before moving to delivery.
    if (item.requiresMerchantAvailabilityConfirmation) {
      requiresConfirmation = true;
    }

    let unitPrice = item.price;

    // Apply variant price if selected
    if (orderItem.variantId) {
      const variant = item.variants.find(v => v.id === orderItem.variantId);
      if (variant) unitPrice = variant.price;
    }

    // Calculate option price deltas
    let optionDelta = 0;
    const optionSelections: Array<{ optionValueId: string; priceDelta: number }> = [];
    if (orderItem.optionSelections?.length) {
      for (const sel of orderItem.optionSelections) {
        const group = item.optionGroups.find(g => g.values.some(v => v.id === sel.optionValueId));
        const value = group?.values.find(v => v.id === sel.optionValueId);
        if (value) {
          optionDelta += value.priceDelta;
          optionSelections.push({ optionValueId: value.id, priceDelta: value.priceDelta });
        }
      }
    }

    unitPrice += optionDelta;
    const quantity = orderItem.quantity || 1;
    const lineTotal = unitPrice * quantity;
    totalAmount += lineTotal;

    priced.push({
      itemId: orderItem.itemId,
      variantId: orderItem.variantId || null,
      quantity,
      unitPrice,
      lineTotal,
      discountAmount: 0,
      optionSelections,
      item,
    });
  }

  // Apply discount rules
  for (const line of priced) {
    const now = new Date();
    const discounts = await prisma.discountRule.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { itemId: line.itemId },
          ...(line.item.categoryId ? [{ categoryId: line.item.categoryId, itemId: null }] : []),
        ],
        ...(line.item.merchantId ? { merchantId: line.item.merchantId } : {}),
        minQuantity: { lte: line.quantity },
      },
    });

    const applicableDiscounts = discounts.filter(discount => isDiscountActive(discount, now));
    const discount = pickBestDiscount(line.lineTotal, applicableDiscounts);

    if (discount) {
      const discountAmount = getDiscountEffectiveAmount(line.lineTotal, discount);
      totalAmount -= discountAmount;
      line.lineTotal -= discountAmount;
      line.discountAmount = discountAmount;
    }
  }

  return { lines: priced, totalAmount: Math.max(0, totalAmount), requiresConfirmation };
}

/** Nested-create payload for Order.orderItems. */
export function toOrderItemsCreate(order: PricedOrder) {
  return order.lines.map(line => ({
    itemId: line.itemId,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    optionSelections: line.optionSelections.length ? { create: line.optionSelections } : undefined,
  }));
}
