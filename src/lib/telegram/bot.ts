/**
 * Handles one Telegram update. Used by both the webhook route and the polling
 * worker, so behaviour is identical whichever delivery mode is configured.
 */
import { sendMessage, type TelegramMessage, type TelegramUpdate } from './bot-api';
import { linkTelegramPhone, setBotBlocked, upsertTelegramUser } from './identity';
import {
  askForPhoneText,
  helpText,
  openAppKeyboard,
  phoneLinkedText,
  phoneMismatchText,
  recentOrdersText,
  shareContactKeyboard,
  unsupportedPhoneText,
  welcomeText,
} from './messages';
import { listTelegramOrders } from './orders';
import { maskPhone } from './phone';

/** /start payloads and Mini App start_params share this format: item_<id> or order_<id>. */
export function startParamToPath(param: string | null | undefined): string {
  const match = /^(item|order)_([A-Za-z0-9-]{1,60})$/.exec(param || '');
  if (!match) return '';
  return match[1] === 'item' ? `/items/${match[2]}` : `/orders/${match[2]}`;
}

function parseCommand(text: string): { command: string; payload: string } | null {
  const match = /^\/([a-z]+)(?:@\w+)?(?:\s+(.+))?$/i.exec(text.trim());
  return match ? { command: match[1].toLowerCase(), payload: (match[2] || '').trim() } : null;
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (update.my_chat_member) {
    const { chat, new_chat_member } = update.my_chat_member;
    if (chat.type === 'private') {
      await setBotBlocked(String(chat.id), new_chat_member.status === 'kicked');
    }
    return;
  }

  const message = update.message;
  // The bot only serves customers in private chats; group messages are ignored.
  if (!message?.from || message.from.is_bot || message.chat.type !== 'private') return;

  const telegramUser = await upsertTelegramUser(message.from, { chatId: message.chat.id });

  if (message.contact) {
    await handleContact(message, telegramUser.telegramUserId);
    return;
  }

  const command = parseCommand(message.text || '');
  const chatId = message.chat.id;
  const linked = Boolean(telegramUser.borrowerId);

  switch (command?.command) {
    case 'start': {
      const path = startParamToPath(command.payload);
      await sendMessage({
        chat_id: chatId,
        text: welcomeText(message.from.first_name),
        parse_mode: 'HTML',
        reply_markup: openAppKeyboard(path ? '🛍 Open in Gebeya' : undefined, path),
      });
      if (!linked) {
        await sendMessage({ chat_id: chatId, text: askForPhoneText, reply_markup: shareContactKeyboard });
      }
      return;
    }
    case 'shop':
      await sendMessage({ chat_id: chatId, text: 'Tap below to browse the shop.', reply_markup: openAppKeyboard() });
      return;
    case 'orders': {
      if (!telegramUser.borrowerId) {
        await sendMessage({ chat_id: chatId, text: askForPhoneText, reply_markup: shareContactKeyboard });
        return;
      }
      const orders = await listTelegramOrders(telegramUser.borrowerId, 5);
      await sendMessage({
        chat_id: chatId,
        text: recentOrdersText(orders),
        parse_mode: 'HTML',
        reply_markup: openAppKeyboard('View all orders', '/orders'),
      });
      return;
    }
    case 'phone':
      await sendMessage({
        chat_id: chatId,
        text: linked
          ? `Your linked number is ${maskPhone(telegramUser.borrowerId!)}. Share a contact again to change it.`
          : askForPhoneText,
        reply_markup: shareContactKeyboard,
      });
      return;
    default:
      await sendMessage({ chat_id: chatId, text: helpText(), parse_mode: 'HTML', reply_markup: openAppKeyboard() });
  }
}

async function handleContact(message: TelegramMessage, telegramUserId: string) {
  const chatId = message.chat.id;
  const contact = message.contact!;

  // Telegram sets contact.user_id when the user shares their own account's
  // number; a forwarded or typed contact would let anyone claim any phone.
  if (contact.user_id !== message.from!.id) {
    await sendMessage({ chat_id: chatId, text: phoneMismatchText, parse_mode: 'HTML', reply_markup: shareContactKeyboard });
    return;
  }

  const result = await linkTelegramPhone(telegramUserId, contact.phone_number);
  if (!result.ok) {
    await sendMessage({ chat_id: chatId, text: unsupportedPhoneText, reply_markup: { remove_keyboard: true } });
    return;
  }

  await sendMessage({
    chat_id: chatId,
    text: phoneLinkedText(maskPhone(result.borrowerId)),
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  });
}
