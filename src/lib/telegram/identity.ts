/**
 * TelegramUser bookkeeping: who has opened the Mini App or written to the bot,
 * and which (Telegram-verified) phone each account is linked to.
 */
import prisma from '@/lib/prisma';
import type { TelegramUser as TelegramProfile } from './bot-api';
import { normalizeEthiopianPhone } from './phone';

// lastSeenAt only needs to be roughly right; skip the write on every request.
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

export async function upsertTelegramUser(profile: TelegramProfile, options: { chatId?: number | string } = {}) {
  const telegramUserId = String(profile.id);
  const fields = {
    username: profile.username ?? null,
    firstName: profile.first_name ?? null,
    lastName: profile.last_name ?? null,
    languageCode: profile.language_code ?? null,
  };
  const chatId = options.chatId != null ? String(options.chatId) : undefined;

  let existing = await prisma.telegramUser.findUnique({ where: { telegramUserId } });
  if (!existing) {
    try {
      return await prisma.telegramUser.create({ data: { telegramUserId, chatId: chatId ?? null, ...fields } });
    } catch (error: any) {
      // Two first requests raced (e.g. the Mini App's parallel fetches); the other one created it.
      if (error?.code !== 'P2002') throw error;
      existing = await prisma.telegramUser.findUniqueOrThrow({ where: { telegramUserId } });
    }
  }

  const changed =
    existing.username !== fields.username ||
    existing.firstName !== fields.firstName ||
    existing.lastName !== fields.lastName ||
    existing.languageCode !== fields.languageCode ||
    (chatId !== undefined && existing.chatId !== chatId) ||
    // A message from the user proves the bot is no longer blocked.
    (chatId !== undefined && existing.botBlockedAt !== null) ||
    Date.now() - existing.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS;

  if (!changed) return existing;

  return prisma.telegramUser.update({
    where: { telegramUserId },
    data: {
      ...fields,
      lastSeenAt: new Date(),
      ...(chatId !== undefined ? { chatId, botBlockedAt: null } : {}),
    },
  });
}

export type LinkPhoneResult = { ok: true; borrowerId: string } | { ok: false; reason: 'INVALID_PHONE' };

/**
 * Links a Telegram account to a phone. Only call this with a contact Telegram
 * itself delivered for the same user (message.contact.user_id === from.id).
 * A phone can be linked to one Telegram account at a time; linking it again
 * from a different account moves it.
 */
export async function linkTelegramPhone(telegramUserId: string, rawPhone: string): Promise<LinkPhoneResult> {
  const borrowerId = normalizeEthiopianPhone(rawPhone);
  if (!borrowerId) return { ok: false, reason: 'INVALID_PHONE' };

  await prisma.$transaction([
    prisma.telegramUser.updateMany({
      where: { borrowerId, telegramUserId: { not: telegramUserId } },
      data: { borrowerId: null, phoneLinkedAt: null },
    }),
    prisma.telegramUser.update({
      where: { telegramUserId },
      data: { borrowerId, phoneLinkedAt: new Date() },
    }),
  ]);

  return { ok: true, borrowerId };
}

export async function setBotBlocked(chatId: string, blocked: boolean) {
  await prisma.telegramUser.updateMany({
    where: { chatId },
    data: { botBlockedAt: blocked ? new Date() : null },
  });
}
