import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { MiniAppAuthError, requireMiniAppAuthContext } from '@/lib/miniapp-auth';
import { isBlocked, recordFailedAttempt, resetAttempts } from '@/lib/rate-limiter';
import { AffiliateError } from '@/lib/affiliate/programs';
import { changeOwnCode, getEarnEntry, getEarnOverview, joinAsAffiliate } from '@/lib/affiliate/earn';
import { requestWithdrawal } from '@/lib/affiliate/withdrawals';
import {
  confirmPointsOrderDelivery,
  createPointsShopOrder,
  requestPointsRepayment,
  requestPointsWithdrawal,
} from '@/lib/affiliate/transfers';

function errorResponse(error: unknown, operation: string) {
  if (error instanceof MiniAppAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
  if (error instanceof AffiliateError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error(`[earn] ${operation} failed:`, error);
  return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
}

/**
 * Borrower-facing Earn page data. `?entry=1` returns only whether to show the
 * Earn link and the available balance for its badge.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await requireMiniAppAuthContext();
    const entryOnly = new URL(req.url).searchParams.get('entry') === '1';
    const data = entryOnly ? await getEarnEntry(ctx.borrowerId) : await getEarnOverview(ctx.borrowerId);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error, 'GET');
  }
}

// Made once per confirmation in the app; repeating a request with it never spends twice.
const requestId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid request. Please try again.');

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('JOIN') }),
  z.object({ action: z.literal('CHANGE_CODE'), code: z.string().trim().min(1, 'Enter a code').max(40) }),
  // Money rewards: everything available within the limits, to the person's own account.
  z.object({ action: z.literal('WITHDRAW') }),
  // Points, always paid from the Affiliate Program account.
  z.object({ action: z.literal('WITHDRAW_POINTS'), points: z.number().int('Use whole points').positive(), requestId }),
  z.object({
    action: z.literal('REPAY_WITH_POINTS'),
    loanId: z.string().min(1),
    amount: z.number({ invalid_type_error: 'Enter an amount' }).positive('Enter an amount to pay'),
    requestId,
  }),
  z.object({
    action: z.literal('SHOP_ORDER'),
    merchantId: z.string().min(1),
    items: z
      .array(
        z.object({
          itemId: z.string().min(1),
          variantId: z.string().nullable().optional(),
          quantity: z.number().int().positive().max(1000).optional(),
          optionSelections: z.array(z.object({ optionValueId: z.string().min(1) })).max(50).optional(),
        })
      )
      .min(1)
      .max(50),
    requestId,
  }),
  z.object({ action: z.literal('CONFIRM_POINTS_DELIVERY'), orderId: z.string().min(1), code: z.string().trim().min(4).max(12) }),
]);

export async function POST(req: NextRequest) {
  let limiterKey: string | null = null;
  try {
    const ctx = await requireMiniAppAuthContext();
    const input = body.parse(await req.json());

    switch (input.action) {
      case 'JOIN':
        return NextResponse.json(await joinAsAffiliate(ctx.borrowerId));
      case 'WITHDRAW':
        return NextResponse.json(await requestWithdrawal(ctx.borrowerId));
      case 'WITHDRAW_POINTS':
        return NextResponse.json(await requestPointsWithdrawal(ctx.borrowerId, input));
      case 'REPAY_WITH_POINTS':
        return NextResponse.json(await requestPointsRepayment(ctx.borrowerId, input));
      case 'SHOP_ORDER':
        return NextResponse.json(await createPointsShopOrder(ctx.borrowerId, input), { status: 201 });
      case 'CONFIRM_POINTS_DELIVERY':
        // Wrong codes are limited like code changes, so delivery codes can't be guessed.
        limiterKey = `earn-delivery:${ctx.borrowerId}`;
        if (isBlocked(limiterKey)) {
          return NextResponse.json({ error: 'Too many attempts. Please wait a minute and try again.' }, { status: 429 });
        }
        {
          const result = await confirmPointsOrderDelivery(ctx.borrowerId, input);
          resetAttempts(limiterKey);
          return NextResponse.json(result);
        }
      case 'CHANGE_CODE': {
        // Failed attempts are limited so the form can't be used to probe which codes exist.
        limiterKey = `earn-code:${ctx.borrowerId}`;
        if (isBlocked(limiterKey)) {
          return NextResponse.json({ error: 'Too many attempts. Please wait a minute and try again.' }, { status: 429 });
        }
        const result = await changeOwnCode(ctx.borrowerId, input.code);
        resetAttempts(limiterKey);
        return NextResponse.json(result);
      }
    }
  } catch (error) {
    if (limiterKey && error instanceof AffiliateError) recordFailedAttempt(limiterKey);
    return errorResponse(error, 'POST');
  }
}
