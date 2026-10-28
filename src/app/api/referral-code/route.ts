import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { MiniAppAuthError, requireMiniAppAuthContext } from '@/lib/miniapp-auth';
import { isBlocked, recordFailedAttempt, resetAttempts } from '@/lib/rate-limiter';
import { AffiliateError } from '@/lib/affiliate/programs';
import { applyReferralCode, getReferralStatus } from '@/lib/affiliate/referrals';

/** Borrower-facing: whether the customer can still enter a referral code. */
export async function GET() {
  try {
    const ctx = await requireMiniAppAuthContext();
    return NextResponse.json(await getReferralStatus(ctx.borrowerId));
  } catch (error) {
    if (error instanceof MiniAppAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[referral-code] GET failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

const body = z.object({ code: z.string().trim().min(1, 'Enter a code').max(40) });

export async function POST(req: NextRequest) {
  let limiterKey: string | null = null;
  try {
    const ctx = await requireMiniAppAuthContext();
    limiterKey = `referral-code:${ctx.borrowerId}`;
    // Slows down guessing other people's codes.
    if (isBlocked(limiterKey)) {
      return NextResponse.json({ error: 'Too many attempts. Please wait a minute and try again.' }, { status: 429 });
    }
    const { code } = body.parse(await req.json());
    const result = await applyReferralCode(ctx.borrowerId, code);
    resetAttempts(limiterKey);
    return NextResponse.json({ success: true, affiliateName: result.affiliateName });
  } catch (error) {
    if (error instanceof MiniAppAuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    if (error instanceof AffiliateError) {
      if (limiterKey) recordFailedAttempt(limiterKey);
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[referral-code] POST failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
