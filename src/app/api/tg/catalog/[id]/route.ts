import { NextRequest, NextResponse } from 'next/server';
import { requireTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { getCatalogItem, parseItemImages } from '@/lib/marketplace/catalog';
import { itemImageUrl } from '@/lib/marketplace/item-images';
import { isTelegramOrderable } from '@/lib/telegram/orders';
import { buildMiniAppDeepLink } from '@/lib/telegram/config';

/** GET /api/tg/catalog/:id */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireTelegramUser(req);

    const { id } = await params;
    const item = await getCatalogItem(id);
    if (!item || item.merchant.status !== 'ACTIVE') {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      currency: item.currency,
      // URLs, not the stored base64 data, so photos are resized and cached.
      images: parseItemImages(item.imageUrl).map((_, index) => ({
        large: itemImageUrl(item.id, index, item.updatedAt, 960),
        thumb: itemImageUrl(item.id, index, item.updatedAt, 200),
      })),
      merchant: { id: item.merchant.id, name: item.merchant.name },
      category: item.category,
      bestDiscount: item.bestDiscount,
      optionGroups: item.optionGroups
        .filter(g => g.values.length > 0)
        .map(g => ({
          id: g.id,
          name: g.name,
          values: g.values.map(v => ({ id: v.id, label: v.label, priceDelta: v.priceDelta })),
        })),
      orderable: isTelegramOrderable(item),
      requiresMerchantConfirmation: item.requiresMerchantAvailabilityConfirmation,
      shareLink: buildMiniAppDeepLink(`item_${item.id}`),
    });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/catalog/[id]');
  }
}
