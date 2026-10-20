import { NextRequest, NextResponse } from 'next/server';
import { requireTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { quoteTelegramOrder, telegramCartSchema, TelegramOrderError } from '@/lib/telegram/orders';

/**
 * POST /api/tg/orders/quote — price a cart without placing it, so the Mini
 * App shows exactly what the order will total (discounts included).
 */
export async function POST(req: NextRequest) {
  try {
    await requireTelegramUser(req);

    const parsed = telegramCartSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid order.', details: parsed.error.flatten() }, { status: 400 });
    }

    return NextResponse.json({ quote: await quoteTelegramOrder(parsed.data) });
  } catch (error) {
    if (error instanceof TelegramOrderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return telegramErrorResponse(error, 'api/tg/orders/quote');
  }
}
