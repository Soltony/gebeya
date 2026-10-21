import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { MiniAppAuthError, requireMiniAppAuthContext } from '@/lib/miniapp-auth';
import { isBlocked, recordFailedAttempt, resetAttempts } from '@/lib/rate-limiter';
import { AffiliateError } from '@/lib/affiliate/programs';
import { changeOwnCode, getEarnEntry, getEarnOverview, joinAsAffiliate } from '@/lib/affiliate/earn';
import { requestWithdrawal } from '@/lib/affiliate/withdrawals';

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

const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('JOIN') }),
  z.object({ action: z.literal('CHANGE_CODE'), code: z.string().trim().min(1, 'Enter a code').max(40) }),
  // Always everything available within the limits, to the person's own account.
  z.object({ action: z.literal('WITHDRAW') }),
]);

export async function POST(req: NextRequest) {
  let limiterKey: string | null = null;
  try {
    const ctx = await requireMiniAppAuthContext();
    const input = body.parse(await req.json());

    if (input.action === 'JOIN') {
      return NextResponse.json(await joinAsAffiliate(ctx.borrowerId));
    }
    if (input.action === 'WITHDRAW') {
      return NextResponse.json(await requestWithdrawal(ctx.borrowerId));
    }

    // Failed attempts are limited so the form can't be used to probe which codes exist.
    limiterKey = `earn-code:${ctx.borrowerId}`;
    if (isBlocked(limiterKey)) {
      return NextResponse.json({ error: 'Too many attempts. Please wait a minute and try again.' }, { status: 429 });
    }
    const result = await changeOwnCode(ctx.borrowerId, input.code);
    resetAttempts(limiterKey);
    return NextResponse.json(result);
  } catch (error) {
    if (limiterKey && error instanceof AffiliateError) recordFailedAttempt(limiterKey);
    return errorResponse(error, 'POST');
  }
}
