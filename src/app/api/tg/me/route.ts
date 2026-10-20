import { NextRequest, NextResponse } from 'next/server';
import { requireTelegramUser, telegramErrorResponse } from '@/lib/telegram/auth';
import { startParamToPath } from '@/lib/telegram/bot';
import { maskPhone } from '@/lib/telegram/phone';

/**
 * GET /api/tg/me
 *
 * The Mini App's identity check. Also tells the app whether the phone is
 * linked yet (polled after requestContact while the bot processes the contact)
 * and which screen a start_param deep link should open.
 */
export async function GET(req: NextRequest) {
  try {
    const { telegramUser, startParam } = await requireTelegramUser(req);
    return NextResponse.json({
      firstName: telegramUser.firstName,
      phoneLinked: Boolean(telegramUser.borrowerId),
      phoneMasked: telegramUser.borrowerId ? maskPhone(telegramUser.borrowerId) : null,
      canMessage: Boolean(telegramUser.chatId) && !telegramUser.botBlockedAt,
      startPath: startParamToPath(startParam),
    });
  } catch (error) {
    return telegramErrorResponse(error, 'api/tg/me');
  }
}
