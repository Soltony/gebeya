import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { parseDayEnd, parseDayStart } from '@/lib/date-utils';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';

const MAX_PAGE_SIZE = 500;

export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || undefined;
    const programId = searchParams.get('programId') || undefined;
    const affiliateId = searchParams.get('affiliateId') || undefined;
    const beneficiary = searchParams.get('beneficiary') || undefined;
    const from = parseDayStart(searchParams.get('from'));
    const to = parseDayEnd(searchParams.get('to'));
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(searchParams.get('pageSize')) || 50));

    const where = {
      ...(status ? { status } : {}),
      ...(affiliateId ? { affiliateId } : {}),
      ...(beneficiary ? { beneficiary } : {}),
      ...(programId ? { referral: { programVersion: { programId } } } : {}),
      ...(from || to ? { eventDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };

    const [total, rows, byStatus] = await Promise.all([
      prisma.affiliateCommission.count({ where }),
      prisma.affiliateCommission.findMany({
        where,
        include: {
          affiliate: { select: { id: true, name: true, code: true } },
          referral: { select: { borrowerId: true, programVersion: { select: { version: true, program: { select: { name: true } } } } } },
        },
        orderBy: { eventDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.affiliateCommission.groupBy({ by: ['status'], where, _sum: { amount: true }, _count: { _all: true } }),
    ]);

    return NextResponse.json({
      total,
      page,
      pageSize,
      totals: byStatus.map((s) => ({ status: s.status, amount: s._sum.amount ?? 0, count: s._count._all })),
      commissions: rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        beneficiary: c.beneficiary,
        beneficiaryPhone: c.beneficiaryPhone,
        ruleName: c.ruleName,
        eventType: c.eventType,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        fundedBy: c.fundedBy,
        baseAmount: c.baseAmount,
        amount: c.amount,
        rewardType: c.rewardType,
        points: c.points,
        eventDate: c.eventDate,
        holdUntil: c.holdUntil,
        reversedReason: c.reversedReason,
        payoutId: c.payoutId,
        affiliate: c.affiliate,
        borrowerId: c.referral.borrowerId,
        program: c.referral.programVersion.program.name,
        programVersion: c.referral.programVersion.version,
      })),
    });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/commissions');
  }
}
