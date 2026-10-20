import { after, NextRequest, NextResponse } from 'next/server';
import { requireLinkedTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { createTelegramOrder, listTelegramOrders, telegramCartSchema, TelegramOrderError } from '@/lib/telegram/orders';
import { notifyTelegramOrderUpdate } from '@/lib/telegram/notifications';
import { takeRateLimit } from '@/lib/telegram/rate-limit';

const ORDERS_PER_WINDOW = 5;
const ORDER_WINDOW_MS = 10 * 60 * 1000;

/** GET /api/tg/orders — the customer's Telegram orders, newest first. */
export async function GET(req: NextRequest) {
  try {
    const { borrowerId } = await requireLinkedTelegramUser(req);
    return NextResponse.json({ orders: await listTelegramOrders(borrowerId) });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/orders GET');
  }
}

/**
 * POST /api/tg/orders — place a direct order.
 * Body: { items: [{ itemId, quantity, optionSelections?: [{ optionValueId }], variantId? }] }
 * The amount is always computed on the server.
 */
export async function POST(req: NextRequest) {
  try {
    const { borrowerId, telegramUser } = await requireLinkedTelegramUser(req);

    const parsed = telegramCartSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid order.', details: parsed.error.flatten() }, { status: 400 });
    }

    if (!takeRateLimit(`tg-order:${telegramUser.telegramUserId}`, ORDERS_PER_WINDOW, ORDER_WINDOW_MS)) {
      return NextResponse.json({ error: 'Too many orders in a short time. Please try again in a few minutes.' }, { status: 429 });
    }

    const order = await createTelegramOrder({ borrowerId, telegramUserId: telegramUser.telegramUserId }, parsed.data);
    after(() => notifyTelegramOrderUpdate(order.id, 'CREATED'));

    return NextResponse.json({ order }, { status: 201 });
  } catch (error) {
    if (error instanceof TelegramOrderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return telegramErrorResponse(error, 'api/tg/orders POST');
  }
}
