import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { REFERRAL_CODE_PATTERN, normalizeReferralCode } from '@/lib/affiliate/config';
import { AffiliateError, assertAffiliateTypeAllowed } from '@/lib/affiliate/programs';
import { affiliateCreateSchema, affiliateUpdateSchema } from '@/lib/affiliate/schemas';
import {
  affiliateErrorResponse,
  createAffiliateChangeRequest,
  pendingRequests,
  requireAffiliateUser,
} from '@/lib/affiliate/requests';

export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search')?.trim();
    const programId = searchParams.get('programId') || undefined;
    const status = searchParams.get('status') || undefined;

    const affiliates = await prisma.affiliate.findMany({
      where: {
        ...(programId ? { programId } : {}),
        ...(status ? { status } : {}),
        ...(search
          ? { OR: [{ name: { contains: search } }, { phoneNumber: { contains: search } }, { code: { contains: search.toUpperCase() } }] }
          : {}),
      },
      include: { program: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const ids = affiliates.map((a) => a.id);

    const [referralCounts, sums, pending] = await Promise.all([
      ids.length
        ? prisma.affiliateReferral.groupBy({ by: ['affiliateId'], where: { affiliateId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } })
        : Promise.resolve([]),
      ids.length
        ? prisma.affiliateCommission.groupBy({
            by: ['affiliateId', 'status', 'kind'],
            where: { affiliateId: { in: ids }, beneficiary: 'AFFILIATE' },
            _sum: { amount: true },
          })
        : Promise.resolve([]),
      pendingRequests('Affiliate'),
    ]);

    const referralsBy = new Map(referralCounts.map((r) => [r.affiliateId, r._count._all]));
    const money = new Map<string, { earned: number; unpaid: number; paid: number }>();
    for (const row of sums) {
      const entry = money.get(row.affiliateId) ?? { earned: 0, unpaid: 0, paid: 0 };
      const amount = row._sum.amount ?? 0;
      if (row.kind === 'EARNED' && row.status !== 'REVERSED') entry.earned += amount;
      if (row.status === 'PAID') entry.paid += amount;
      if (['PENDING', 'PAYABLE', 'IN_PAYOUT'].includes(row.status)) entry.unpaid += amount;
      money.set(row.affiliateId, entry);
    }

    return NextResponse.json({
      affiliates: affiliates.map((a) => ({
        id: a.id,
        code: a.code,
        type: a.type,
        name: a.name,
        phoneNumber: a.phoneNumber,
        email: a.email,
        payoutAccount: a.payoutAccount,
        status: a.status,
        source: a.source,
        suspendedReason: a.suspendedReason,
        program: a.program,
        createdAt: a.createdAt,
        referralCount: referralsBy.get(a.id) ?? 0,
        ...(money.get(a.id) ?? { earned: 0, unpaid: 0, paid: 0 }),
        pendingChange: pending.some((p) => p.entityId === a.id),
      })),
      pendingCreates: pending.filter((p) => p.changeType === 'CREATE').map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
    });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates');
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('create');
  if (auth.response) return auth.response;

  try {
    const body = affiliateCreateSchema.parse(await req.json());
    const program = await prisma.affiliateProgram.findUnique({ where: { id: body.programId }, select: { name: true } });
    if (!program) throw new AffiliateError('Program not found.', 404);
    await assertAffiliateTypeAllowed(body.programId, body.type);

    const existing = await prisma.affiliate.findUnique({ where: { phoneNumber: body.phoneNumber }, select: { id: true } });
    if (existing) throw new AffiliateError('This phone number is already registered as an affiliate.', 409);
    const pending = await prisma.pendingChange.findMany({
      where: { entityType: 'Affiliate', changeType: 'CREATE', status: 'PENDING' },
      select: { payload: true },
    });
    const phoneWaiting = pending.some((p) => {
      try {
        return JSON.parse(p.payload)?.created?.phoneNumber === body.phoneNumber;
      } catch {
        return false;
      }
    });
    if (phoneWaiting) throw new AffiliateError('An affiliate with this phone number is already waiting for approval.', 409);

    let code: string | null = null;
    if (body.code) {
      code = normalizeReferralCode(body.code);
      if (!REFERRAL_CODE_PATTERN.test(code)) throw new AffiliateError('Codes must be 4 to 16 letters or digits.');
      const taken = await prisma.affiliate.findUnique({ where: { code }, select: { id: true } });
      if (taken) throw new AffiliateError(`The code ${code} is already used by another affiliate.`, 409);
    }

    const change = await createAffiliateChangeRequest(auth.user, {
      entityType: 'Affiliate',
      changeType: 'CREATE',
      payload: {
        created: {
          name: body.name,
          phoneNumber: body.phoneNumber,
          type: body.type,
          programId: body.programId,
          program: program.name,
          email: body.email ?? null,
          payoutAccount: body.payoutAccount ?? null,
          code,
        },
      },
    });
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates');
  }
}

const updateBody = affiliateUpdateSchema.omit({ status: true }).extend({ affiliateId: z.string().min(1) });

export async function PUT(req: NextRequest) {
  const auth = await requireAffiliateUser('update');
  if (auth.response) return auth.response;

  try {
    const { affiliateId, ...fields } = updateBody.parse(await req.json());
    const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateId }, include: { program: { select: { name: true } } } });
    if (!affiliate) throw new AffiliateError('Affiliate not found.', 404);

    const programId = fields.programId ?? affiliate.programId;
    const type = fields.type ?? affiliate.type;
    if (programId !== affiliate.programId || type !== affiliate.type) await assertAffiliateTypeAllowed(programId, type);
    const payoutAccount = fields.payoutAccount !== undefined ? fields.payoutAccount : affiliate.payoutAccount;
    if (type !== 'BORROWER' && !payoutAccount) {
      throw new AffiliateError('A payout account is required (only borrowers can be paid into their linked account).');
    }
    const newProgram =
      programId !== affiliate.programId
        ? await prisma.affiliateProgram.findUnique({ where: { id: programId }, select: { name: true } })
        : affiliate.program;

    const original: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const compare = (key: string, before: unknown, after: unknown) => {
      if (after === undefined || after === before) return;
      original[key] = before;
      updated[key] = after;
    };
    compare('name', affiliate.name, fields.name);
    compare('type', affiliate.type, fields.type);
    compare('programId', affiliate.programId, fields.programId);
    compare('email', affiliate.email, fields.email);
    compare('payoutAccount', affiliate.payoutAccount, fields.payoutAccount);
    if (!Object.keys(updated).length) throw new AffiliateError('Nothing was changed.', 400);
    if ('programId' in updated) {
      original.program = affiliate.program.name;
      updated.program = newProgram?.name ?? programId;
    }
    // Shown as the item name on the Approvals page.
    original.name = original.name ?? affiliate.name;
    updated.name = updated.name ?? affiliate.name;

    const change = await createAffiliateChangeRequest(auth.user, {
      entityType: 'Affiliate',
      entityId: affiliate.id,
      changeType: 'UPDATE',
      payload: { original, updated },
    });
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'PUT /api/affiliates');
  }
}
