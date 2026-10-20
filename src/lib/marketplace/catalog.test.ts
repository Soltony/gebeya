import { describe, expect, test } from 'vitest';
import { buildCatalogWhere } from './catalog';
import { isTelegramOrderable, TELEGRAM_ORDERABLE_SELLING_OPTIONS } from '@/lib/telegram/orders';

describe('buildCatalogWhere', () => {
  test('without sellingOptions it lists every active item (super-app shop)', () => {
    expect(buildCatalogWhere({})).toEqual({ status: 'ACTIVE', merchant: { status: 'ACTIVE' } });
  });

  test('the Telegram shop lists only items that can be paid for directly', () => {
    const where = buildCatalogWhere({ sellingOptions: TELEGRAM_ORDERABLE_SELLING_OPTIONS });
    expect(where.sellingOption).toEqual({ in: ['DIRECT_ONLY', 'BOTH'] });
  });

  test('keeps search, category and merchant filters alongside the selling option', () => {
    const where = buildCatalogWhere({ search: 'shoe', categoryId: 'c1', merchantId: 'm1', sellingOptions: ['BOTH'] });
    expect(where).toMatchObject({ categoryId: 'c1', merchantId: 'm1', sellingOption: { in: ['BOTH'] } });
    expect(where.OR).toHaveLength(3);
  });
});

describe('isTelegramOrderable', () => {
  test('direct-payable items are sold in Telegram; BNPL-only (and unset, which defaults to BNPL-only) are not', () => {
    expect(isTelegramOrderable({ sellingOption: 'BOTH' })).toBe(true);
    expect(isTelegramOrderable({ sellingOption: 'DIRECT_ONLY' })).toBe(true);
    expect(isTelegramOrderable({ sellingOption: 'BNPL_ONLY' })).toBe(false);
    expect(isTelegramOrderable({ sellingOption: null })).toBe(false);
  });
});
