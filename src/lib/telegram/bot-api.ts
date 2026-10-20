/**
 * Minimal Telegram Bot API client. Only the methods Gebeya uses are typed; the
 * rest of the API can be reached through callTelegram().
 */
import { getApiBaseUrl, getBotToken } from './config';

const DEFAULT_TIMEOUT_MS = 15_000;

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
  }

  /** The user blocked the bot, deleted their account, or never started a chat. */
  get isUnreachableUser(): boolean {
    return this.errorCode === 403 || /chat not found/i.test(this.description);
  }
}

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
};

export type TelegramChat = { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };

export type TelegramContact = {
  phone_number: string;
  first_name: string;
  last_name?: string;
  user_id?: number;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  contact?: TelegramContact;
};

export type TelegramChatMemberUpdated = {
  chat: TelegramChat;
  from: TelegramUser;
  new_chat_member: { status: string; user: TelegramUser };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
};

export type InlineKeyboardButton =
  | { text: string; web_app: { url: string } }
  | { text: string; url: string };

export type ReplyMarkup =
  | { inline_keyboard: InlineKeyboardButton[][] }
  | {
      keyboard: Array<Array<{ text: string; request_contact?: boolean }>>;
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
      is_persistent?: boolean;
      input_field_placeholder?: string;
    }
  | { remove_keyboard: true };

export type SendMessageParams = {
  chat_id: string | number;
  text: string;
  parse_mode?: 'HTML';
  reply_markup?: ReplyMarkup;
  link_preview_options?: { is_disabled: boolean };
};

/** Updates the bot asks Telegram for, in both webhook and polling mode. */
export const ALLOWED_UPDATES = ['message', 'my_chat_member'] as const;

export async function callTelegram<T>(
  method: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${getApiBaseUrl()}/bot${getBotToken()}/${method}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    cache: 'no-store',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const body: any = await res.json().catch(() => null);
  if (!body?.ok) {
    throw new TelegramApiError(
      method,
      Number(body?.error_code ?? res.status),
      String(body?.description ?? res.statusText ?? 'Unknown error'),
      body?.parameters?.retry_after,
    );
  }
  return body.result as T;
}

export function sendMessage(params: SendMessageParams) {
  return callTelegram<TelegramMessage>('sendMessage', params);
}

/** HTML parse mode only needs these three characters escaped. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
