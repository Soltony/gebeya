import { NextRequest, NextResponse } from 'next/server';
import { requireTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { listActiveCategories, listActiveMerchants, listCatalogItems, parseItemImages } from '@/lib/marketplace/catalog';
import { isTelegramOrderable } from '@/lib/telegram/orders';

/** GET /api/tg/catalog?search=&categoryId=&merchantId= */
export async function GET(req: NextRequest) {
  try {
    await requireTelegramUser(req);

    const { searchParams } = new URL(req.url);
    const [items, categories, merchants] = await Promise.all([
      listCatalogItems({
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
        image: parseItemImages(item.imageUrl)[0] ?? null,
        merchant: item.merchant,
        category: item.category,
        orderable: isTelegramOrderable(item),
      })),
      categories: categories.map(c => ({ id: c.id, name: c.name })),
      merchants: merchants.map(m => ({ id: m.id, name: m.name, iconUrl: m.iconUrl })),
    });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/catalog');
  }
}
