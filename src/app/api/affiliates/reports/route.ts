import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { parseDayEnd, parseDayStart } from '@/lib/date-utils';
import { chunk } from '@/lib/affiliate/db';
import { roundMoney } from '@/lib/affiliate/engine';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';

type Totals = {
  referrals: number;
  customersWithLoans: number;
  nplCustomers: number;
  defaultRate: number | null;
  earnedAffiliate: number;
  earnedCustomer: number;
  reversed: number;
  takenBackAfterPayment: number;
  paid: number;
  unpaid: number;
};

const emptyTotals = (): Totals => ({
  referrals: 0,
  customersWithLoans: 0,
  nplCustomers: 0,
  defaultRate: null,
  earnedAffiliate: 0,
  earnedCustomer: 0,
  reversed: 0,
  takenBackAfterPayment: 0,
  paid: 0,
  unpaid: 0,
});

/**
 * Performance per program and per affiliate. The default rate (referred
 * customers now NPL / referred customers with a loan) is the main quality
 * signal for an affiliate. Money columns use the commission event date.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const programId = searchParams.get('programId') || undefined;
    const from = parseDayStart(searchParams.get('from'));
    const to = parseDayEnd(searchParams.get('to'));
    const range = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

    const [programs, affiliates] = await Promise.all([
      prisma.affiliateProgram.findMany({
        where: programId ? { id: programId } : {},
        select: { id: true, name: true, status: true },
        orderBy: { name: 'asc' },
      }),
      prisma.affiliate.findMany({
        where: programId ? { programId } : {},
        select: { id: true, name: true, code: true, status: true, type: true, programId: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const referrals = await prisma.affiliateReferral.findMany({
      where: {
        status: 'ACTIVE',
        ...(programId ? { programVersion: { programId } } : {}),
        ...(range ? { attributedAt: range } : {}),
      },
      select: { affiliateId: true, borrowerId: true, programVersion: { select: { programId: true } } },
    });

    const borrowerIds = Array.from(new Set(referrals.map((r) => r.borrowerId)));
    const npl = new Set<string>();
    const withLoans = new Set<string>();
    for (const ids of chunk(borrowerIds)) {
      const [borrowers, loans] = await Promise.all([
        prisma.borrower.findMany({ where: { id: { in: ids }, status: 'NPL' }, select: { id: true } }),
        prisma.loan.groupBy({ by: ['borrowerId'], where: { borrowerId: { in: ids } } }),
      ]);
      borrowers.forEach((b) => npl.add(b.id));
      loans.forEach((l) => withLoans.add(l.borrowerId));
    }

    const sums = await prisma.affiliateCommission.groupBy({
      by: ['affiliateId', 'beneficiary', 'kind', 'status'],
      where: {
        ...(programId ? { referral: { programVersion: { programId } } } : {}),
        ...(range ? { eventDate: range } : {}),
      },
      _sum: { amount: true },
    });

    const byAffiliate = new Map<string, Totals>(affiliates.map((a) => [a.id, emptyTotals()]));
    const programOf = new Map(affiliates.map((a) => [a.id, a.programId]));
    const byProgram = new Map<string, Totals>(programs.map((p) => [p.id, emptyTotals()]));

    for (const r of referrals) {
      const t = byAffiliate.get(r.affiliateId);
      if (t) {
        t.referrals++;
        if (withLoans.has(r.borrowerId)) t.customersWithLoans++;
        if (npl.has(r.borrowerId)) t.nplCustomers++;
      }
      const p = byProgram.get(r.programVersion.programId);
      if (p) {
        p.referrals++;
        if (withLoans.has(r.borrowerId)) p.customersWithLoans++;
        if (npl.has(r.borrowerId)) p.nplCustomers++;
      }
    }

    for (const row of sums) {
      const amount = row._sum.amount ?? 0;
      const targets = [byAffiliate.get(row.affiliateId), byProgram.get(programOf.get(row.affiliateId) ?? '')];
      for (const t of targets) {
        if (!t) continue;
        if (row.kind === 'EARNED' && row.status !== 'REVERSED') {
          if (row.beneficiary === 'AFFILIATE') t.earnedAffiliate += amount;
          else t.earnedCustomer += amount;
        }
        if (row.kind === 'EARNED' && row.status === 'REVERSED') t.reversed += amount;
        if (row.kind === 'CLAWBACK') t.takenBackAfterPayment += -amount;
        if (row.status === 'PAID') t.paid += amount;
        if (['PENDING', 'PAYABLE', 'IN_PAYOUT'].includes(row.status)) t.unpaid += amount;
      }
    }

    const finish = (t: Totals): Totals => ({
      ...t,
      defaultRate: t.customersWithLoans > 0 ? roundMoney((t.nplCustomers / t.customersWithLoans) * 100) : null,
      earnedAffiliate: roundMoney(t.earnedAffiliate),
      earnedCustomer: roundMoney(t.earnedCustomer),
      reversed: roundMoney(t.reversed),
      takenBackAfterPayment: roundMoney(t.takenBackAfterPayment),
      paid: roundMoney(t.paid),
      unpaid: roundMoney(t.unpaid),
    });

    const programNames = new Map(programs.map((p) => [p.id, p.name]));
    return NextResponse.json({
      programs: programs.map((p) => ({ id: p.id, name: p.name, status: p.status, ...finish(byProgram.get(p.id)!) })),
      affiliates: affiliates.map((a) => ({
        id: a.id,
        name: a.name,
        code: a.code,
        type: a.type,
        status: a.status,
        program: programNames.get(a.programId) ?? '',
        ...finish(byAffiliate.get(a.id)!),
      })),
    });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/reports');
  }
}
