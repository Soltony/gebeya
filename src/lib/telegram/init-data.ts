/**
 * Validation of the initData string Telegram hands a Mini App on launch.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * The data-check-string is every received field except `hash`, sorted by key
 * and joined as key=value lines. Newer clients also send `signature` (used for
 * third-party Ed25519 checks); it stays in the string for the bot-token check.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { TelegramUser } from './bot-api';

export class InitDataError extends Error {}

export type ValidatedInitData = {
  user: TelegramUser;
  authDate: Date;
  startParam: string | null;
  queryId: string | null;
};

export function computeInitDataHash(params: URLSearchParams, botToken: string): string {
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

export function validateInitData(
  rawInitData: string,
  botToken: string,
  options: { maxAgeSeconds: number; now?: Date },
): ValidatedInitData {
  if (!rawInitData) throw new InitDataError('initData is empty.');

  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[0-9a-f]{64}$/i.test(receivedHash)) {
    throw new InitDataError('initData hash is missing or malformed.');
  }

  const expected = Buffer.from(computeInitDataHash(params, botToken), 'hex');
  const received = Buffer.from(receivedHash.toLowerCase(), 'hex');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new InitDataError('initData signature does not match.');
  }

  const authDateSeconds = Number(params.get('auth_date'));
  if (!Number.isFinite(authDateSeconds) || authDateSeconds <= 0) {
    throw new InitDataError('initData auth_date is missing.');
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (nowSeconds - authDateSeconds > options.maxAgeSeconds) {
    throw new InitDataError('initData has expired. Reopen the Mini App.');
  }

  let user: TelegramUser;
  try {
    user = JSON.parse(params.get('user') || '');
  } catch {
    throw new InitDataError('initData user is missing.');
  }
  if (!user || typeof user.id !== 'number') throw new InitDataError('initData user is missing.');

  return {
    user,
    authDate: new Date(authDateSeconds * 1000),
    startParam: params.get('start_param'),
    queryId: params.get('query_id'),
  };
}
