/**
 * Telegram bot + Mini App settings, read from the environment on each call so
 * a restart is the only thing needed after changing them.
 *
 * See the "Telegram bot & Mini App" section of .env.example for what each one
 * does and README.md for the BotFather setup steps.
 */

export type TelegramUpdateMode = 'webhook' | 'polling';

export class TelegramConfigError extends Error {}

const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TelegramConfigError(`${name} is not configured.`);
  return value;
}

export function isTelegramEnabled(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

export function getBotToken(): string {
  return required('TELEGRAM_BOT_TOKEN');
}

/** Base URL of the Bot API. Point it at a proxy or a local Bot API server if the host cannot reach api.telegram.org directly. */
export function getApiBaseUrl(): string {
  return (process.env.TELEGRAM_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
}

export function getUpdateMode(): TelegramUpdateMode {
  const mode = (process.env.TELEGRAM_UPDATE_MODE?.trim() || 'webhook').toLowerCase();
  if (mode !== 'webhook' && mode !== 'polling') {
    throw new TelegramConfigError(`TELEGRAM_UPDATE_MODE must be "webhook" or "polling", got "${mode}".`);
  }
  return mode;
}

export function getWebhookSecret(): string {
  const secret = required('TELEGRAM_WEBHOOK_SECRET');
  // Telegram only accepts 1-256 characters from A-Z, a-z, 0-9, _ and -.
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    throw new TelegramConfigError('TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z, a-z, 0-9, _ or -.');
  }
  return secret;
}

export function getWebhookUrl(): string {
  return required('TELEGRAM_WEBHOOK_URL');
}

/** Public HTTPS URL of the Mini App root (the /tg page), without a trailing slash. */
export function getMiniAppUrl(): string {
  return required('TELEGRAM_MINIAPP_URL').replace(/\/+$/, '');
}

export function getBotUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || null;
}

/** Short name given to the Mini App in BotFather (/newapp). Enables t.me/<bot>/<app>?startapp= links. */
export function getMiniAppShortName(): string | null {
  return process.env.TELEGRAM_MINIAPP_SHORT_NAME?.trim() || null;
}

export function getInitDataMaxAgeSeconds(): number {
  const parsed = Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_INIT_DATA_MAX_AGE_SECONDS;
}

/**
 * Local development only: lets the Mini App run in a normal browser by
 * treating requests without initData as this Telegram user id. Ignored in
 * production builds.
 */
export function getDevBypassTelegramUserId(): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  return process.env.TELEGRAM_DEV_BYPASS_USER_ID?.trim() || null;
}

export function getSupportText(): string | null {
  return process.env.TELEGRAM_SUPPORT_TEXT?.trim() || null;
}

/** Link that opens the Mini App, optionally at a start_param such as item_<id>. */
export function buildMiniAppDeepLink(startParam?: string): string | null {
  const bot = getBotUsername();
  if (!bot) return null;
  const shortName = getMiniAppShortName();
  const query = startParam ? `?startapp=${encodeURIComponent(startParam)}` : '';
  return shortName ? `https://t.me/${bot}/${shortName}${query}` : `https://t.me/${bot}${startParam ? `?start=${encodeURIComponent(startParam)}` : ''}`;
}
