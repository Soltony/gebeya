import { after, NextRequest, NextResponse } from 'next/server';
import type { PushTransition } from '@/lib/nib-push/push-payments';
import { requireLinkedTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { notifyTelegramPaymentUpdate } from '@/lib/telegram/notifications';
import { getTelegramOrder, TelegramOrderError } from '@/lib/telegram/orders';
import { payTelegramOrder, refreshTelegramOrderPayment } from '@/lib/telegram/payments';
import { takeRateLimit } from '@/lib/telegram/rate-limit';

const PROMPTS_PER_WINDOW = 5;
const PROMPT_WINDOW_MS = 10 * 60 * 1000;

function notifyAfterResponse(transitions: PushTransition[]) {
  if (transitions.length === 0) return;
  after(async () => {
    for (const transition of transitions) await notifyTelegramPaymentUpdate(transition);
  });
}

/**
 * GET /api/tg/orders/:id/pay — the order with its payment state. Polled while
 * the customer enters their PIN. The bank is asked about unfinished prompts
 * after responding, so a slow or unreachable bank never holds up the screen;
 * the next poll shows what it settled.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { borrowerId } = await requireLinkedTelegramUser(req);
    const { id } = await params;

    after(async () => {
      try {
        for (const transition of await refreshTelegramOrderPayment(borrowerId, id)) {
          await notifyTelegramPaymentUpdate(transition);
        }
      } catch (error) {
        console.error('[telegram-pay] background status check failed', { orderId: id, error: String(error) });
      }
    });

    const order = await getTelegramOrder(borrowerId, id);
    if (!order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
    return NextResponse.json({ order });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/orders/[id]/pay GET');
  }
}

/**
 * POST /api/tg/orders/:id/pay — send (or resend) a NIB USSD payment prompt to
 * the customer's linked phone. The amount is always the order total.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { borrowerId, telegramUser } = await requireLinkedTelegramUser(req);
    const { id } = await params;

    if (!takeRateLimit(`tg-pay:${telegramUser.telegramUserId}`, PROMPTS_PER_WINDOW, PROMPT_WINDOW_MS)) {
      return NextResponse.json({ error: 'Too many payment attempts. Please try again in a few minutes.' }, { status: 429 });
    }

    // Settle what the bank already knows before sending another prompt.
    notifyAfterResponse(await refreshTelegramOrderPayment(borrowerId, id));

    await payTelegramOrder({ borrowerId, telegramUserId: telegramUser.telegramUserId }, id, {
      ipAddress: req.headers.get('x-forwarded-for') || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
    });

    const order = await getTelegramOrder(borrowerId, id);
    return NextResponse.json({ order });
  } catch (error) {
    if (error instanceof TelegramOrderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return telegramErrorResponse(error, 'api/tg/orders/[id]/pay POST');
  }
}
