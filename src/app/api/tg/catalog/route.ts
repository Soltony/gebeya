import { NextRequest, NextResponse } from 'next/server';
import { requireTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { listActiveCategories, listActiveMerchants, listCatalogItemsLean } from '@/lib/marketplace/catalog';
import { itemImageUrl } from '@/lib/marketplace/item-images';
import { isTelegramOrderable } from '@/lib/telegram/orders';

/**
 * GET /api/tg/catalog?search=&categoryId=&merchantId=
 *
 * Kept small on purpose: no photo data, only a URL for each item's first
 * photo (fetched and cached separately by the webview).
 */
export async function GET(req: NextRequest) {
  try {
    await requireTelegramUser(req);

    const { searchParams } = new URL(req.url);
    const [items, categories, merchants] = await Promise.all([
      listCatalogItemsLean({
        search: searchParams.get('search')?.slice(0, 100) || '',
        categoryId: searchParams.get('categoryId') || '',
        merchantId: searchParams.get('merchantId') || '',
      }),
      listActiveCategories(),
      listActiveMerchants(),
    ]);

    return NextResponse.json({
      items: items.map(item => ({
        id: item.id,
        name: item.name,
        price: item.price,
        currency: item.currency,
        discountedPrice: item.discountedPrice,
        bestDiscount: item.bestDiscount,
        // May 404 for items without a photo; the card falls back to a placeholder.
        image: itemImageUrl(item.id, 0, item.updatedAt, 400),
        merchant: item.merchant,
        category: item.category,
        orderable: isTelegramOrderable(item),
      })),
      categories: categories.map(c => ({ id: c.id, name: c.name })),
      merchants: merchants.map(m => ({ id: m.id, name: m.name })),
    });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/catalog');
  }
}
