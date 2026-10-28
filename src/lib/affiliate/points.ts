/**
 * The points wallet.
 *
 * Programs with reward type POINTS credit rewards as points instead of money:
 * when a commission's hold ends it becomes CREDITED and an EARN row is added
 * here; a take-back after that adds a negative REVERSAL row. Admins add or
 * remove points through maker-checker (ADJUST). A balance is always the sum
 * of a person's rows, and rows are never edited.
 *
 * No money moves yet: what points can be used for comes later, and points are
 * not posted to provider ledgers until finance decides how they are booked.
 */
import { format, startOfMonth } from 'date-fns';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { getPhoneNumbersForAccount } from '@/lib/account-utils';
import { DEFAULT_POINTS_SETTINGS, pointsSettingsSchema, type PointsSettings } from './config';
import { isUniqueViolation } from './db';
import { roundMoney } from './engine';
import { findAffiliateForPhones, ownPoints } from './people';
import { AffiliateError, generateCode } from './programs';
import { normalizePhone } from './schemas';

export const POINT_TYPES = ['EARN', 'REVERSAL', 'ADJUST'] as const;
export type PointType = (typeof POINT_TYPES)[number];

/** The settings change request's entity id: one settings record, so one pending change at a time. */
export const POINTS_SETTINGS_ENTITY_ID = 'points-settings';

export function newPointsReference(now = new Date()): string {
  return `PTS-${format(now, 'yyMMdd')}-${generateCode(8)}`;
}

export type PostPointsInput = {
  idempotencyKey: string;
  phone: string;
  affiliateId?: string | null;
  type: PointType;
  points: number;
  birrValue: number;
  commissionId?: string | null;
  programId?: string | null;
  note?: string | null;
  createdById?: string | null;
  approvedById?: string | null;
};

/** Adds one row to the points wallet. Call inside the transaction that caused it. */
export async function postPoints(tx: Prisma.TransactionClient, input: PostPointsInput) {
  return tx.affiliatePointTransaction.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      reference: newPointsReference(),
      phone: input.phone,
      affiliateId: input.affiliateId ?? null,
      type: input.type,
      points: Math.round(input.points),
      birrValue: roundMoney(input.birrValue),
      commissionId: input.commissionId ?? null,
      programId: input.programId ?? null,
      note: input.note ?? null,
      createdById: input.createdById ?? null,
      approvedById: input.approvedById ?? null,
    },
  });
}

export type PointsSettingsState = { settings: PointsSettings; version: number; publishedAt: Date | null };

/** The latest approved settings; the defaults until the first change is approved. */
export async function getPointsSettings(): Promise<PointsSettingsState> {
  const latest = await prisma.affiliatePointsSettingsVersion.findFirst({ orderBy: { version: 'desc' } });
  if (!latest) return { settings: DEFAULT_POINTS_SETTINGS, version: 0, publishedAt: null };
  let parsed: PointsSettings = DEFAULT_POINTS_SETTINGS;
  try {
    const result = pointsSettingsSchema.safeParse(JSON.parse(latest.config));
    if (result.success) parsed = result.data;
  } catch {
    parsed = DEFAULT_POINTS_SETTINGS;
  }
  return { settings: parsed, version: latest.version, publishedAt: latest.publishedAt };
}

export function describePointsSettings(settings: PointsSettings): string {
  const perBirr = Math.round((1 / settings.pointValue) * 100) / 100;
  return `1 point is worth ${settings.pointValue} ETB (${perBirr} points = 1 ETB).`;
}

/** A person's wallet: their phones (linked accounts included) and their affiliate, if any. */
export async function walletFor(phone: string) {
  const phones = await getPhoneNumbersForAccount(phone);
  const affiliate = await findAffiliateForPhones(phones);
  const where = ownPoints(affiliate?.id ?? null, phones);
  const sum = await prisma.affiliatePointTransaction.aggregate({ where, _sum: { points: true } });
  return { phones, affiliate, where, balance: sum._sum.points ?? 0 };
}

// ---------------------------------------------------------------------------
// Applying approved changes (called from the Approvals flow)
// ---------------------------------------------------------------------------

type ApprovedChange = { id: string; payload: string; createdById: string };

export async function applyPointsSettingsChange(change: ApprovedChange, actorId?: string) {
  const data = JSON.parse(change.payload);
  const parsed = pointsSettingsSchema.safeParse(data?.updated?.settings);
  if (!parsed.success) throw new AffiliateError('The points settings in this request are not valid.');
  const current = await getPointsSettings();
  // The request carries the version it was made from; never apply it over a newer one.
  if (data?.original?.version !== current.version) {
    throw new AffiliateError('The points settings changed after this request was made. Reject it and submit a new one.', 409);
  }
  const created = await prisma.affiliatePointsSettingsVersion.create({
    data: { version: current.version + 1, config: JSON.stringify(parsed.data), publishedById: change.createdById },
  });
  await createAuditLog({
    actorId: actorId ?? 'system',
    action: 'AFFILIATE_POINTS_SETTINGS_UPDATED',
    entity: 'AffiliatePointsSettings',
    entityId: POINTS_SETTINGS_ENTITY_ID,
    details: { changeId: change.id, version: created.version, settings: parsed.data },
  });
}

export async function applyPointAdjustment(change: ApprovedChange, actorId?: string) {
  const data = JSON.parse(change.payload)?.created ?? {};
  const phone = typeof data.phone === 'string' ? normalizePhone(data.phone) : null;
  const points = Number(data.points);
  if (!phone || !Number.isInteger(points) || points === 0) throw new AffiliateError('This points adjustment is not valid.');

  const idempotencyKey = `ADJUST:${change.id}`;
  const alreadyApplied = new AffiliateError('This adjustment was already applied.', 409);
  if (await prisma.affiliatePointTransaction.findUnique({ where: { idempotencyKey }, select: { id: true } })) throw alreadyApplied;

  const wallet = await walletFor(phone);
  if (points < 0 && wallet.balance + points < 0) {
    throw new AffiliateError(`This would take the balance below zero (it is now ${wallet.balance} points).`, 409);
  }
  const { settings } = await getPointsSettings();
  const owner = await prisma.affiliate.findUnique({ where: { phoneNumber: phone }, select: { id: true } });
  let row;
  try {
    row = await prisma.$transaction((tx) =>
      postPoints(tx, {
        idempotencyKey,
        phone,
        affiliateId: owner?.id ?? null,
        type: 'ADJUST',
        points,
        birrValue: points * settings.pointValue,
        note: typeof data.reason === 'string' ? data.reason : null,
        createdById: change.createdById,
        approvedById: actorId ?? null,
      })
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw alreadyApplied;
    throw error;
  }
  await createAuditLog({
    actorId: actorId ?? 'system',
    action: 'AFFILIATE_POINTS_ADJUSTED',
    entity: 'AffiliatePointTransaction',
    entityId: row.id,
    details: { changeId: change.id, phone, points, reference: row.reference },
  });
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

export async function pointsSummary(pointValue: number) {
  const monthStart = startOfMonth(new Date());
  const [all, month] = await Promise.all([
    prisma.affiliatePointTransaction.aggregate({ _sum: { points: true } }),
    prisma.affiliatePointTransaction.groupBy({
      by: ['type'],
      where: { createdAt: { gte: monthStart } },
      _sum: { points: true },
    }),
  ]);
  const of = (type: PointType) => month.find((m) => m.type === type)?._sum.points ?? 0;
  const outstanding = all._sum.points ?? 0;
  return {
    outstanding,
    outstandingValue: roundMoney(outstanding * pointValue),
    earnedThisMonth: of('EARN'),
    takenBackThisMonth: -of('REVERSAL'),
    adjustedThisMonth: of('ADJUST'),
  };
}

/**
 * Point rows for the admin history: by phone (the whole wallet, linked phones
 * included), by reference, or by affiliate code.
 */
export async function listPointTransactions(input: { search?: string | null; type?: string | null; take?: number }) {
  const search = input.search?.trim() ?? '';
  const filters: Prisma.AffiliatePointTransactionWhereInput[] = [];
  let wallet: { phone: string; balance: number; name: string | null } | null = null;

  if (search) {
    if (/^PTS-/i.test(search)) {
      filters.push({ reference: { contains: search.toUpperCase() } });
    } else if (normalizePhone(search) && /^[\d\s+]+$/.test(search)) {
      const phone = normalizePhone(search)!;
      const found = await walletFor(phone);
      filters.push(found.where);
      wallet = { phone, balance: found.balance, name: found.affiliate?.name ?? null };
    } else {
      const affiliate = await prisma.affiliate.findUnique({ where: { code: search.toUpperCase() }, select: { id: true, phoneNumber: true, name: true } });
      if (!affiliate) return { wallet: null, transactions: [] };
      const found = await walletFor(affiliate.phoneNumber);
      filters.push(found.where);
      wallet = { phone: affiliate.phoneNumber, balance: found.balance, name: affiliate.name };
    }
  }
  if (input.type && (POINT_TYPES as readonly string[]).includes(input.type)) filters.push({ type: input.type });

  const transactions = await prisma.affiliatePointTransaction.findMany({
    where: filters.length ? { AND: filters } : {},
    include: { affiliate: { select: { name: true, code: true } } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(input.take ?? 200, 500),
  });
  return { wallet, transactions };
}
