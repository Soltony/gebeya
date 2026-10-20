import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getUpdateMode, getWebhookSecret, isTelegramEnabled, TelegramConfigError } from '@/lib/telegram/config';
import { handleTelegramUpdate } from '@/lib/telegram/bot';
import type { TelegramUpdate } from '@/lib/telegram/bot-api';

/**
 * POST /api/telegram/webhook
 *
 * Receives bot updates when TELEGRAM_UPDATE_MODE=webhook. Telegram proves the
 * request is genuine by echoing the secret_token given to setWebhook in the
 * X-Telegram-Bot-Api-Secret-Token header (see scripts/telegram-setup.ts).
 */
function secretMatches(received: string | null, expected: string) {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  let expectedSecret: string;
  try {
    if (!isTelegramEnabled() || getUpdateMode() !== 'webhook') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    expectedSecret = getWebhookSecret();
  } catch (error) {
    if (error instanceof TelegramConfigError) {
      console.error('[telegram/webhook] misconfigured:', error.message);
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    throw error;
  }

  if (!secretMatches(req.headers.get('x-telegram-bot-api-secret-token'), expectedSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    await handleTelegramUpdate(update);
  } catch (error) {
    // Acknowledge anyway: a non-2xx makes Telegram redeliver the same update
    // repeatedly and hold back newer ones behind it.
    console.error('[telegram/webhook] update handling failed', { updateId: update?.update_id, error });
  }

  return NextResponse.json({ ok: true });
}
