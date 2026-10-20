import { describe, expect, test } from 'vitest';
import { assertTelegramOrderRules, telegramCartSchema, TelegramOrderError, type TelegramCart } from './orders';
import { startParamToPath } from './bot';
import type { PricedOrder } from '@/lib/marketplace/order-pricing';

function pricedItem(overrides: Record<string, any> = {}) {
  return {
    id: 'item1',
    name: 'Phone case',
    merchantId: 'm1',
    categoryId: 'c1',
    sellingOption: 'DIRECT_ONLY',
    currency: 'ETB',
    merchant: { id: 'm1', name: 'Shop', status: 'ACTIVE' },
    variants: [{ id: 'v1', status: 'ACTIVE' }, { id: 'v-old', status: 'ARCHIVED' }],
    optionGroups: [
      {
        id: 'g-color',
        name: 'Color',
        status: 'ACTIVE',
        values: [
          { id: 'red', status: 'ACTIVE' },
          { id: 'blue', status: 'ACTIVE' },
          { id: 'green', status: 'ARCHIVED' },
        ],
      },
      { id: 'g-old', name: 'Size', status: 'ARCHIVED', values: [{ id: 'xl', status: 'ARCHIVED' }] },
    ],
    ...overrides,
  };
}

function priced(...items: Array<ReturnType<typeof pricedItem>>): PricedOrder {
  return {
    totalAmount: 100,
    requiresConfirmation: false,
    lines: items.map(item => ({
      itemId: item.id,
      variantId: null,
      quantity: 1,
      unitPrice: 100,
      lineTotal: 100,
      discountAmount: 0,
      optionSelections: [],
      item: item as any,
    })),
  };
}

function cart(lines: Array<Partial<TelegramCart['items'][number]>>): TelegramCart {
  return {
    items: lines.map(l => ({ itemId: 'item1', quantity: 1, optionSelections: [{ optionValueId: 'red' }], ...l })),
  };
}

describe('assertTelegramOrderRules', () => {
  test('returns the merchant for a valid single-merchant cart', () => {
    expect(assertTelegramOrderRules(cart([{}]), priced(pricedItem()))).toBe('m1');
  });

  test('rejects BNPL-only items', () => {
    expect(() => assertTelegramOrderRules(cart([{}]), priced(pricedItem({ sellingOption: 'BNPL_ONLY' })))).toThrow(/pay-later/);
    expect(() => assertTelegramOrderRules(cart([{}]), priced(pricedItem({ sellingOption: null })))).toThrow(/pay-later/);
  });

  test('accepts items sold both ways', () => {
    expect(assertTelegramOrderRules(cart([{}]), priced(pricedItem({ sellingOption: 'BOTH' })))).toBe('m1');
  });

  test('rejects carts spanning merchants', () => {
    const other = pricedItem({ id: 'item2', merchantId: 'm2', merchant: { id: 'm2', name: 'Other', status: 'ACTIVE' } });
    expect(() => assertTelegramOrderRules(cart([{}, { itemId: 'item2' }]), priced(pricedItem(), other))).toThrow(/different merchants/);
  });

  test('rejects inactive merchants', () => {
    const item = pricedItem({ merchant: { id: 'm1', name: 'Shop', status: 'PENDING_APPROVAL' } });
    expect(() => assertTelegramOrderRules(cart([{}]), priced(item))).toThrow(/not available/);
  });

  test('requires every active option group to be answered once', () => {
    expect(() => assertTelegramOrderRules(cart([{ optionSelections: [] }]), priced(pricedItem()))).toThrow(/Choose a Color/);
    expect(() =>
      assertTelegramOrderRules(cart([{ optionSelections: [{ optionValueId: 'red' }, { optionValueId: 'blue' }] }]), priced(pricedItem())),
    ).toThrow(/Choose one Color/);
  });

  test('rejects archived or foreign option values', () => {
    for (const optionValueId of ['green', 'xl', 'not-this-item']) {
      expect(() => assertTelegramOrderRules(cart([{ optionSelections: [{ optionValueId }] }]), priced(pricedItem()))).toThrow(
        TelegramOrderError,
      );
    }
  });

  test('rejects unknown or archived variants', () => {
    expect(() => assertTelegramOrderRules(cart([{ variantId: 'v-old' }]), priced(pricedItem()))).toThrow(/version/);
    expect(assertTelegramOrderRules(cart([{ variantId: 'v1' }]), priced(pricedItem()))).toBe('m1');
  });
});

describe('telegramCartSchema', () => {
  test('bounds quantity and requires at least one line', () => {
    expect(telegramCartSchema.safeParse({ items: [] }).success).toBe(false);
    expect(telegramCartSchema.safeParse({ items: [{ itemId: 'a', quantity: 0 }] }).success).toBe(false);
    expect(telegramCartSchema.safeParse({ items: [{ itemId: 'a', quantity: -3 }] }).success).toBe(false);
    expect(telegramCartSchema.safeParse({ items: [{ itemId: 'a', quantity: 1.5 }] }).success).toBe(false);
    expect(telegramCartSchema.safeParse({ items: [{ itemId: 'a', quantity: 100 }] }).success).toBe(false);
    expect(telegramCartSchema.safeParse({ items: [{ itemId: 'a', quantity: 2 }] }).success).toBe(true);
  });
});

describe('startParamToPath', () => {
  test('maps item and order deep links', () => {
    expect(startParamToPath('item_clx123abc')).toBe('/items/clx123abc');
    expect(startParamToPath('order_clx999')).toBe('/orders/clx999');
  });

  test('ignores anything else', () => {
    expect(startParamToPath('')).toBe('');
    expect(startParamToPath(null)).toBe('');
    expect(startParamToPath('item_../../admin')).toBe('');
    expect(startParamToPath('promo_2026')).toBe('');
  });
});
