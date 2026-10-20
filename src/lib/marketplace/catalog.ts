/**
 * Marketplace catalog reads shared by the super-app shop (/api/shop) and the
 * Telegram Mini App (/api/tg/catalog).
 */
import prisma from '@/lib/prisma';
import { isDiscountActive, pickBestDiscount } from '@/lib/discount-utils';

export type CatalogFilters = {
  search?: string;
  categoryId?: string;
  merchantId?: string;
};

export async function listCatalogItems({ search = '', categoryId = '', merchantId = '' }: CatalogFilters) {
  const where: any = { status: 'ACTIVE', merchant: { status: 'ACTIVE' } };

  if (search) {
    where.OR = [
      { name: { contains: search } },
      { description: { contains: search } },
      { merchant: { name: { contains: search } } },
    ];
  }
  if (categoryId) where.categoryId = categoryId;
  if (merchantId) where.merchantId = merchantId;

  const items = await prisma.item.findMany({
    where,
    include: {
      merchant: { select: { id: true, name: true } },
      category: { select: { id: true, name: true } },
      variants: { where: { status: 'ACTIVE' } },
      discountRules: { where: { status: 'ACTIVE' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Also fetch category-level discounts
  const now = new Date();
  const categoryDiscounts = await prisma.discountRule.findMany({
    where: {
      status: 'ACTIVE',
      categoryId: { not: null },
      itemId: null,
    },
  });

  // Merge item-level + category-level discounts and compute best discount
  return items.map(item => {
    const itemDiscounts = item.discountRules.filter(rule =>
      isDiscountActive(rule, now) && (!rule.merchantId || rule.merchantId === item.merchantId)
    );
    const catDiscounts = item.categoryId
      ? categoryDiscounts.filter(r =>
          r.categoryId === item.categoryId &&
          r.minQuantity <= 1 &&
          isDiscountActive(r, now) &&
          (!r.merchantId || r.merchantId === item.merchantId)
        )
      : [];
    const allDiscounts = [...itemDiscounts, ...catDiscounts];

    const selectedDiscount = pickBestDiscount(Number(item.price), allDiscounts);
    const bestDiscount = selectedDiscount
      ? { type: String(selectedDiscount.type || '').toUpperCase(), value: selectedDiscount.value, name: selectedDiscount.name }
      : null;

    const discountedPrice = bestDiscount
      ? Math.max(0, bestDiscount.type === 'PERCENTAGE'
          ? Number(item.price) - (Number(item.price) * bestDiscount.value) / 100
          : Number(item.price) - bestDiscount.value)
      : null;

    return {
      ...item,
      discountRules: allDiscounts,
      bestDiscount,
      discountedPrice,
    };
  });
}

export function listActiveCategories() {
  return prisma.productCategory.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { name: 'asc' },
  });
}

export function listActiveMerchants() {
  return prisma.merchant.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, name: true, iconUrl: true, bnplEnabled: true },
    orderBy: { name: 'asc' },
  });
}

/** One active item with its variants, option groups and applicable discounts, or null. */
export async function getCatalogItem(id: string) {
  const item = await prisma.item.findUnique({
    where: { id, status: 'ACTIVE' },
    include: {
      merchant: { select: { id: true, name: true, status: true, bnplEnabled: true } },
      category: { select: { id: true, name: true } },
      variants: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } },
      optionGroups: {
        where: { status: 'ACTIVE' },
        include: { values: { where: { status: 'ACTIVE' } } },
        orderBy: { createdAt: 'asc' },
      },
      discountRules: { where: { status: 'ACTIVE' } },
    },
  });

  if (!item) return null;

  const now = new Date();
  const itemDiscounts = item.discountRules.filter(r => isDiscountActive(r, now) && (!r.merchantId || r.merchantId === item.merchantId));

  // Also fetch category-level discounts
  let catDiscounts: any[] = [];
  if (item.categoryId) {
    catDiscounts = await prisma.discountRule.findMany({
      where: {
        status: 'ACTIVE',
        categoryId: item.categoryId,
        itemId: null,
        OR: [{ merchantId: item.merchantId }, { merchantId: null }],
      },
    });
  }

  const allDiscounts = [...itemDiscounts, ...catDiscounts.filter(r => isDiscountActive(r, now))];

  const selectedDiscount = pickBestDiscount(Number(item.price), allDiscounts);
  const bestDiscount = selectedDiscount
    ? { type: String(selectedDiscount.type || '').toUpperCase(), value: selectedDiscount.value, name: selectedDiscount.name }
    : null;

  return { ...item, discountRules: allDiscounts, bestDiscount };
}

/**
 * Image URLs are stored either as a single URL or as a JSON array string.
 */
export function parseItemImages(imageUrl: string | null | undefined): string[] {
  if (!imageUrl) return [];
  const trimmed = imageUrl.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.filter((s: any) => typeof s === 'string' && s);
    } catch { /* ignore */ }
  }
  if (trimmed) return [trimmed];
  return [];
}
