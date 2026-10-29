import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import {
  cancelDraftBatch,
  preparePayoutBatch,
  confirmPayoutPaid,
  releasePayout,
  sendPayout,
  submitPayoutBatch,
} from '@/lib/affiliate/payouts';
import { SELF_SERVICE } from '@/lib/affiliate/earn-rules';
import { approveWithdrawal, declineWithdrawal } from '@/lib/affiliate/withdrawals';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';

export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const programId = searchParams.get('programId') || undefined;
    const status = searchParams.get('status') || undefined;
    // WITHDRAWALS: customers' own; BATCHES: prepared by admins or the schedule.
    const kind = searchParams.get('kind');

    const batches = await prisma.affiliatePayoutBatch.findMany({
      where: {
        ...(programId ? { programId } : {}),
        ...(status ? { status } : {}),
        ...(kind === 'WITHDRAWALS' ? { source: SELF_SERVICE } : kind === 'BATCHES' ? { source: { not: SELF_SERVICE } } : {}),
      },
      include: {
        program: { select: { id: true, name: true } },
        payouts: {
          include: { affiliate: { select: { id: true, name: true, code: true } } },
          orderBy: { netAmount: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const waitingForReview = await prisma.affiliatePayoutBatch.count({ where: { source: SELF_SERVICE, status: 'PENDING_APPROVAL' } });
    return NextResponse.json({ batches, waitingForReview });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/payouts');
  }
}

const actionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('PREPARE'), programId: z.string().min(1) }),
  z.object({ action: z.literal('SUBMIT'), batchId: z.string().min(1) }),
  z.object({ action: z.literal('CANCEL'), batchId: z.string().min(1) }),
  z.object({ action: z.literal('RETRY'), payoutId: z.string().min(1) }),
  z.object({ action: z.literal('RELEASE'), payoutId: z.string().min(1) }),
  // The bank says a failed payout went through after all: settle it with its FT number.
  z.object({ action: z.literal('CONFIRM_PAID'), payoutId: z.string().min(1), bankReference: z.string().trim().min(4).max(40) }),
  z.object({ action: z.literal('APPROVE_WITHDRAWAL'), batchId: z.string().min(1) }),
  z.object({
    action: z.literal('DECLINE_WITHDRAWAL'),
    batchId: z.string().min(1),
    reason: z.string().trim().min(3, 'Give a reason').max(500),
  }),
]);

// Reviewing a customer's withdrawal is the checker's job, as on the Approvals page.
const REVIEW_ACTIONS = new Set(['APPROVE_WITHDRAWAL', 'DECLINE_WITHDRAWAL']);

export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const body = actionBody.parse(await req.json());
    const review = REVIEW_ACTIONS.has(body.action);
    const allowed = review ? !!auth.user.permissions?.approvals?.update : !!auth.user.permissions?.affiliates?.update;
    if (!allowed) {
      return NextResponse.json(
        { error: review ? 'Only a checker (Update on Approvals) can review withdrawals.' : 'Not authorized' },
        { status: 403 }
      );
    }

    switch (body.action) {
      case 'PREPARE': {
        const result = await preparePayoutBatch(body.programId, { source: 'MANUAL', createdById: auth.user.id });
        return NextResponse.json(result, { status: result.batchId ? 201 : 200 });
      }
      case 'SUBMIT':
        await submitPayoutBatch(body.batchId, auth.user);
        return NextResponse.json({ success: true });
      case 'CANCEL':
        await cancelDraftBatch(body.batchId, auth.user);
        return NextResponse.json({ success: true });
      case 'RETRY': {
        const outcome = await sendPayout(body.payoutId, { retry: true, actorId: auth.user.id });
        if (outcome.status === 'SKIPPED') return NextResponse.json({ error: outcome.message }, { status: 409 });
        return NextResponse.json(outcome);
      }
      case 'CONFIRM_PAID':
        await confirmPayoutPaid(body.payoutId, auth.user, body.bankReference);
        return NextResponse.json({ success: true });
      case 'RELEASE':
        await releasePayout(body.payoutId, auth.user);
        return NextResponse.json({ success: true });
      case 'APPROVE_WITHDRAWAL':
        await approveWithdrawal(body.batchId, auth.user);
        return NextResponse.json({ success: true });
      case 'DECLINE_WITHDRAWAL':
        await declineWithdrawal(body.batchId, auth.user, body.reason);
        return NextResponse.json({ success: true });
    }
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/payouts');
  }
}
