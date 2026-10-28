import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import {
  describePointsSettings,
  getPointsSettings,
  listPointTransactions,
  pointsSummary,
} from '@/lib/affiliate/points';
import { requestPointAdjustment, requestPointsSettingsChange } from '@/lib/affiliate/points-admin';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';

/** Points settings, totals, pending requests and the points history (searchable). */
export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const [state, pending, history] = await Promise.all([
      getPointsSettings(),
      prisma.pendingChange.findMany({
        where: { entityType: { in: ['AffiliatePointsSettings', 'AffiliatePointAdjustment'] }, status: 'PENDING' },
        select: { id: true, entityType: true, payload: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      listPointTransactions({ search: searchParams.get('search'), type: searchParams.get('type') }),
    ]);
    const nameOf = (payload: string) => {
      try {
        return JSON.parse(payload)?.created?.name ?? null;
      } catch {
        return null;
      }
    };

    return NextResponse.json({
      settings: {
        ...state.settings,
        version: state.version,
        publishedAt: state.publishedAt,
        summary: describePointsSettings(state.settings),
      },
      settingsPending: pending.some((p) => p.entityType === 'AffiliatePointsSettings'),
      pendingAdjustments: pending
        .filter((p) => p.entityType === 'AffiliatePointAdjustment')
        .map((p) => ({ id: p.id, name: nameOf(p.payload), createdAt: p.createdAt })),
      summary: await pointsSummary(state.settings.pointValue),
      wallet: history.wallet,
      transactions: history.transactions.map((t) => ({
        id: t.id,
        reference: t.reference,
        createdAt: t.createdAt,
        phone: t.phone,
        affiliate: t.affiliate,
        type: t.type,
        points: t.points,
        birrValue: t.birrValue,
        note: t.note,
      })),
    });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/points');
  }
}

const body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ADJUST'),
    phone: z.string().trim().min(1, 'Enter a phone number'),
    points: z.number({ invalid_type_error: 'Enter the points' }).int('Use whole points'),
    reason: z.string().trim().min(3, 'Give a reason').max(500),
  }),
  z.object({ action: z.literal('UPDATE_SETTINGS'), settings: z.unknown() }),
]);

/** Maker steps: both go to the Approvals page for a checker. */
export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('update');
  if (auth.response) return auth.response;

  try {
    const input = body.parse(await req.json());
    const change =
      input.action === 'ADJUST'
        ? await requestPointAdjustment(auth.user, input)
        : await requestPointsSettingsChange(auth.user, input.settings);
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/points');
  }
}
