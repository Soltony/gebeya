import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { freezeAccount } from '@/lib/affiliate/account';
import {
  accountOverview,
  listAccountEntries,
  listTransfers,
  requestAccountMovement,
  requestAccountSettingsChange,
  requestAccountUnfreeze,
} from '@/lib/affiliate/account-admin';
import {
  approveTransfer,
  confirmTransferPaid,
  declineTransfer,
  releaseTransfer,
  resolveUnappliedTransfer,
  retryTransfer,
} from '@/lib/affiliate/transfers';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';

/** The Affiliate Program account: balance, pending requests, its ledger and the transfers paid from it. */
export async function GET(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const [overview, entries, transfers] = await Promise.all([
      accountOverview(),
      listAccountEntries({ type: searchParams.get('entryType'), search: searchParams.get('entrySearch') }),
      listTransfers({
        purpose: searchParams.get('purpose'),
        status: searchParams.get('status'),
        search: searchParams.get('transferSearch'),
      }),
    ]);
    return NextResponse.json({ ...overview, entries, transfers });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/account');
  }
}

const id = z.string().min(1);
const reason = z.string().trim().min(3, 'Give a reason').max(500);
const bankReference = z.string().trim().min(4, 'Enter the bank reference').max(40);

const body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('UPDATE_SETTINGS'),
    name: z.string().trim().min(2).max(120),
    accountNumber: z.string().trim().max(34).nullable(),
    cbsProviderId: z.string().trim().max(40).nullable(),
  }),
  z.object({ action: z.literal('FREEZE'), reason }),
  z.object({ action: z.literal('UNFREEZE') }),
  z.object({
    action: z.literal('MOVEMENT'),
    kind: z.enum(['FUNDING', 'ADJUSTMENT']),
    direction: z.enum(['CREDIT', 'DEBIT']),
    amount: z.number({ invalid_type_error: 'Enter an amount' }).positive('Enter an amount above 0'),
    bankReference,
    note: z.string().trim().max(500).nullable(),
  }),
  z.object({ action: z.literal('APPROVE_TRANSFER'), id }),
  z.object({ action: z.literal('DECLINE_TRANSFER'), id, reason }),
  z.object({ action: z.literal('RETRY_TRANSFER'), id }),
  z.object({ action: z.literal('CONFIRM_TRANSFER'), id, bankReference }),
  z.object({ action: z.literal('RELEASE_TRANSFER'), id, reason }),
  z.object({ action: z.literal('RESOLVE_TRANSFER'), id, reason }),
]);

// Approving or declining a customer's withdrawal is the checker's job, as on the Approvals page.
const REVIEW_ACTIONS = new Set(['APPROVE_TRANSFER', 'DECLINE_TRANSFER']);

export async function POST(req: NextRequest) {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const input = body.parse(await req.json());
    const review = REVIEW_ACTIONS.has(input.action);
    const allowed = review ? !!auth.user.permissions?.approvals?.update : !!auth.user.permissions?.affiliates?.update;
    if (!allowed) {
      return NextResponse.json(
        { error: review ? 'Only a checker (Update on Approvals) can review withdrawals.' : 'Not authorized' },
        { status: 403 }
      );
    }

    switch (input.action) {
      case 'UPDATE_SETTINGS': {
        const change = await requestAccountSettingsChange(auth.user, input);
        return NextResponse.json({ changeId: change.id }, { status: 201 });
      }
      case 'FREEZE':
        await freezeAccount(input.reason, auth.user.id);
        return NextResponse.json({ success: true });
      case 'UNFREEZE': {
        const change = await requestAccountUnfreeze(auth.user);
        return NextResponse.json({ changeId: change.id }, { status: 201 });
      }
      case 'MOVEMENT': {
        const change = await requestAccountMovement(auth.user, input);
        return NextResponse.json({ changeId: change.id }, { status: 201 });
      }
      case 'APPROVE_TRANSFER':
        await approveTransfer(input.id, auth.user);
        return NextResponse.json({ success: true });
      case 'DECLINE_TRANSFER':
        await declineTransfer(input.id, auth.user, input.reason);
        return NextResponse.json({ success: true });
      case 'RETRY_TRANSFER':
        return NextResponse.json(await retryTransfer(input.id, auth.user));
      case 'CONFIRM_TRANSFER':
        return NextResponse.json(await confirmTransferPaid(input.id, auth.user, input.bankReference));
      case 'RELEASE_TRANSFER':
        await releaseTransfer(input.id, auth.user, input.reason);
        return NextResponse.json({ success: true });
      case 'RESOLVE_TRANSFER':
        await resolveUnappliedTransfer(input.id, auth.user, input.reason);
        return NextResponse.json({ success: true });
    }
  } catch (error) {
    return affiliateErrorResponse(error, 'POST /api/affiliates/account');
  }
}
