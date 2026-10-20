import { after, NextRequest, NextResponse } from 'next/server';
import { requireLinkedTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { cancelTelegramOrder, TelegramOrderError } from '@/lib/telegram/orders';
import { notifyTelegramOrderUpdate } from '@/lib/telegram/notifications';

/** POST /api/tg/orders/:id/cancel — Body: { reason?: string } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { borrowerId, telegramUser } = await requireLinkedTelegramUser(req);
    const { id } = await params;

    const body = await req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : 'Cancelled by customer';

    await cancelTelegramOrder({ borrowerId, telegramUserId: telegramUser.telegramUserId }, id, reason);
    after(() => notifyTelegramOrderUpdate(id, 'STATUS_CHANGED'));

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TelegramOrderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return telegramErrorResponse(error, 'api/tg/orders/[id]/cancel');
  }
}
