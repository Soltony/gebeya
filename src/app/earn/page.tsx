import { redirect } from 'next/navigation';
import { requireMiniAppAuthContext } from '@/lib/miniapp-auth';
import { EarnClient } from '@/components/earn/earn-client';

// Resolve the customer on every request; with the dev bypass on nothing here
// reads cookies, and Next would otherwise prerender the page at build time.
export const dynamic = 'force-dynamic';

/** Mini-app Earn page: referral code, invited friends and earnings, for customers and agents. */
export default async function EarnPage() {
  const ctx = await requireMiniAppAuthContext().catch(() => null);
  if (!ctx) redirect('/loan/connect');
  return <EarnClient borrowerId={ctx.borrowerId} />;
}
