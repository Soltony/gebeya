/**
 * Authentication for /api/tg/* routes. The Mini App sends its raw initData on
 * every request in the `X-Telegram-Init-Data` header (`Authorization: tma
 * <initData>` is also accepted); it is validated against the bot token here
 * rather than exchanged for a cookie, because cookies are unreliable inside
 * Telegram's webviews and the Telegram Web iframe.
 */
import { NextResponse } from 'next/server';
import { getBotToken, getDevBypassTelegramUserId, getInitDataMaxAgeSeconds, TelegramConfigError } from './config';
import { InitDataError, validateInitData } from './init-data';
import { upsertTelegramUser } from './identity';
import type { TelegramUser as TelegramProfile } from './bot-api';

export class TelegramAuthError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
  }
}

export type TelegramRequestContext = {
  telegramUser: Awaited<ReturnType<typeof upsertTelegramUser>>;
  startParam: string | null;
};

export type LinkedTelegramRequestContext = TelegramRequestContext & { borrowerId: string };

function readInitData(req: Request): string | null {
  const custom = req.headers.get('x-telegram-init-data')?.trim();
  if (custom) return custom;
  const match = (req.headers.get('authorization') || '').match(/^tma\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function requireTelegramUser(req: Request): Promise<TelegramRequestContext> {
  const initData = readInitData(req);

  let profile: TelegramProfile;
  let startParam: string | null = null;

  if (!initData) {
    const devUserId = getDevBypassTelegramUserId();
    if (!devUserId) {
      console.warn('[telegram-auth] request without initData', { path: new URL(req.url).pathname });
      throw new TelegramAuthError(401, 'Open this page from the Telegram bot.', 'NO_INIT_DATA');
    }
    profile = { id: Number(devUserId), first_name: 'Dev', username: 'dev_bypass' };
  } else {
    try {
      const validated = validateInitData(initData, getBotToken(), { maxAgeSeconds: getInitDataMaxAgeSeconds() });
      profile = validated.user;
      startParam = validated.startParam;
    } catch (error) {
      if (error instanceof InitDataError) {
        // "signature does not match" here almost always means TELEGRAM_BOT_TOKEN
        // in this process belongs to a different bot than the one that opened the app.
        console.warn('[telegram-auth] initData rejected', { path: new URL(req.url).pathname, reason: error.message });
        throw new TelegramAuthError(401, error.message, 'INVALID_INIT_DATA');
      }
      throw error;
    }
  }

  const telegramUser = await upsertTelegramUser(profile);
  return { telegramUser, startParam };
}

export async function requireLinkedTelegramUser(req: Request): Promise<LinkedTelegramRequestContext> {
  const ctx = await requireTelegramUser(req);
  if (!ctx.telegramUser.borrowerId) {
    throw new TelegramAuthError(403, 'Share your phone number with the bot to continue.', 'PHONE_NOT_LINKED');
  }
  return { ...ctx, borrowerId: ctx.telegramUser.borrowerId };
}

/** Maps errors thrown by Telegram route handlers to JSON responses. */
export function telegramErrorResponse(error: unknown, logLabel: string) {
  if (error instanceof TelegramAuthError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof TelegramConfigError) {
    console.error(`[${logLabel}] Telegram is not configured:`, error.message);
    return NextResponse.json({ error: 'Telegram is not configured on the server.' }, { status: 503 });
  }
  console.error(`[${logLabel}]`, error);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}
