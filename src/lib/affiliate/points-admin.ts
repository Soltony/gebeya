/**
 * Maker steps for points: an admin asks to add or remove points, or to change
 * the points settings, and a checker approves it on the Approvals page
 * (applied by points.ts). Kept apart from points.ts so the worker never loads
 * the admin session code that requests.ts needs.
 */
import prisma from '@/lib/prisma';
import { formatPoints, formatConfigErrors, pointsSettingsSchema } from './config';
import { AffiliateError } from './programs';
import { createAffiliateChangeRequest } from './requests';
import { normalizePhone } from './schemas';
import { POINTS_SETTINGS_ENTITY_ID, describePointsSettings, getPointsSettings, walletFor } from './points';

const MAX_ADJUSTMENT = 10_000_000;

export async function requestPointAdjustment(user: { id: string }, input: { phone: string; points: number; reason: string }) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AffiliateError('Enter a valid phone number.');
  const points = Number(input.points);
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > MAX_ADJUSTMENT) {
    throw new AffiliateError('Enter a whole number of points, more or less than 0.');
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new AffiliateError('Give a reason.');

  const [wallet, account, borrower] = await Promise.all([
    walletFor(phone),
    prisma.phoneAccount.findFirst({ where: { phoneNumber: phone }, select: { customerName: true } }),
    prisma.borrower.findUnique({ where: { id: phone }, select: { id: true } }),
  ]);
  if (!wallet.affiliate && !account && !borrower) {
    throw new AffiliateError('No customer or affiliate has this phone number.', 404);
  }
  if (points < 0 && wallet.balance + points < 0) {
    throw new AffiliateError(`This would take the balance below zero (it is now ${formatPoints(wallet.balance)}).`);
  }

  const person = wallet.affiliate?.name ?? account?.customerName ?? phone;
  return createAffiliateChangeRequest(user, {
    entityType: 'AffiliatePointAdjustment',
    changeType: 'CREATE',
    payload: {
      created: {
        name: `${points > 0 ? 'Add' : 'Remove'} ${formatPoints(Math.abs(points))} – ${person}`,
        phone,
        person,
        points,
        reason,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance + points,
      },
    },
  });
}

export async function requestPointsSettingsChange(user: { id: string }, input: unknown) {
  const parsed = pointsSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AffiliateError(formatConfigErrors(parsed.error).join('\n'));
  const current = await getPointsSettings();
  if (JSON.stringify(parsed.data) === JSON.stringify(current.settings)) throw new AffiliateError('Nothing was changed.');

  // Both sides carry the same keys so the approval screen diffs them correctly.
  return createAffiliateChangeRequest(user, {
    entityType: 'AffiliatePointsSettings',
    entityId: POINTS_SETTINGS_ENTITY_ID,
    changeType: 'UPDATE',
    payload: {
      original: { name: 'Points settings', version: current.version, summary: describePointsSettings(current.settings), settings: current.settings },
      updated: { name: 'Points settings', version: current.version + 1, summary: describePointsSettings(parsed.data), settings: parsed.data },
    },
  });
}
