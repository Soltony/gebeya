import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { AffiliateError, suspendAffiliate } from '@/lib/affiliate/programs';
import { affiliateErrorResponse, createAffiliateChangeRequest, requireAffiliateUser } from '@/lib/affiliate/requests';

const body = z.object({
  affiliateId: z.string().min(1),
  action: z.enum(['SUSPEND', 'REACTIVATE']),
  reason: z.string().trim().max(1000).optional(),
});

/**
 * Suspending is immediate: no new commissions, and payouts are held. Reactivating
 * releases them again, so it goes through approval.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('update');
  if (auth.response) return auth.response;

  try {
    const { affiliateId, action, reason } = body.parse(await req.json());
    if (action === 'SUSPEND') {
      if (!reason) throw new AffiliateError('Give a reason for the suspension.');
      await suspendAffiliate(affiliateId, reason, auth.user.id);
      return NextResponse.json({ success: true });
    }

    const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateId } });
    if (!affiliate) throw new AffiliateError('Affiliate not found.', 404);
    if (affiliate.status !== 'SUSPENDED') throw new AffiliateError('Only a suspended affiliate can be reactivated.', 409);
    const change = await createAffiliateChangeRequest(auth.user, {
      entityType: 'Affiliate',
      entityId: affiliate.id,
      changeType: 'UPDATE',
      payload: {
        original: { name: affiliate.name, status: 'SUSPENDED', suspendedReason: affiliate.suspendedReason },
        updated: { name: affiliate.name, status: 'ACTIVE', suspendedReason: null },
      },
    });
    return NextResponse.json({ changeId: change.id }, { status: 201 });
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/status');
  }
}
