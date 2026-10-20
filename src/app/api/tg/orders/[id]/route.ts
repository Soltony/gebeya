import { NextRequest, NextResponse } from 'next/server';
import { requireLinkedTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { getTelegramOrder } from '@/lib/telegram/orders';

/** GET /api/tg/orders/:id — one of the customer's Telegram orders. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { borrowerId } = await requireLinkedTelegramUser(req);
    const { id } = await params;

    const order = await getTelegramOrder(borrowerId, id);
    if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });

    return NextResponse.json({ order });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/orders/[id]');
  }
}
