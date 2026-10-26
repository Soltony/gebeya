/**
 * Who paid, for admin views of order payments. Super-app customers are named
 * from their provisioned data; Telegram customers have none, so their name
 * comes from their Telegram profile. Borrower ids are phone numbers.
 */
import prisma from '@/lib/prisma';

/** Telegram display names by borrower id, newest link first. */
export async function telegramNamesByBorrower(borrowerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (borrowerIds.length === 0) return names;

  const users = await prisma.telegramUser.findMany({
    where: { borrowerId: { in: [...new Set(borrowerIds)] } },
    select: { borrowerId: true, firstName: true, lastName: true, username: true },
    orderBy: { phoneLinkedAt: 'desc' },
  });
  for (const user of users) {
    if (!user.borrowerId || names.has(user.borrowerId)) continue;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : '');
    if (name) names.set(user.borrowerId, name);
  }
  return names;
}
