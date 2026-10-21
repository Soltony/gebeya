import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { rejectReferral } from '@/lib/affiliate/referrals';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';

const MAX_PAGE_SIZE = 200;

export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const programId = searchParams.get('programId') || undefined;
    const affiliateId = searchParams.get('affiliateId') || undefined;
    const status = searchParams.get('status') || undefined;
    const search = searchParams.get('search')?.trim();
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(searchParams.get('pageSize')) || 50));

    const where = {
      ...(programId ? { programVersion: { programId } } : {}),
      ...(affiliateId ? { affiliateId } : {}),
      ...(status ? { status } : {}),
      ...(search ? { borrowerId: { contains: search } } : {}),
    };
    const [total, referrals] = await Promise.all([
      prisma.affiliateReferral.count({ where }),
      prisma.affiliateReferral.findMany({
        where,
        include: {
          affiliate: { select: { id: true, name: true, code: true } },
          programVersion: { select: { version: true, program: { select: { id: true, name: true } } } },
        },
        orderBy: { attributedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const ids = referrals.map((r) => r.id);
    const sums = ids.length
      ? await prisma.affiliateCommission.groupBy({
          by: ['referralId'],
          where: { referralId: { in: ids }, status: { not: 'REVERSED' } },
          _sum: { amount: true },
        })
      : [];
    const earnedBy = new Map(sums.map((s) => [s.referralId, s._sum.amount ?? 0]));

    return NextResponse.json({
      total,
      page,
      pageSize,
      referrals: referrals.map((r) => ({
        id: r.id,
        borrowerId: r.borrowerId,
        source: r.source,
        status: r.status,
        rejectedReason: r.rejectedReason,
        attributedAt: r.attributedAt,
        affiliate: r.affiliate,
        program: r.programVersion.program,
        programVersion: r.programVersion.version,
        commissionTotal: earnedBy.get(r.id) ?? 0,
      })),
    });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/referrals');
  }
}

const rejectBody = z.object({
  action: z.literal('REJECT'),
  referralId: z.string().min(1),
  reason: z.string().trim().min(3, 'Give a reason').max(1000),
});

/** Rejecting is immediate: it can only take money back, never pay more. */
export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('update');
  if (auth.response) return auth.response;

  try {
    const { referralId, reason } = rejectBody.parse(await req.json());
    const result = await rejectReferral(referralId, reason, auth.user.id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/referrals');
  }
}
