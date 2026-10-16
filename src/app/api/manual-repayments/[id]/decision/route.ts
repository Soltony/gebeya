/**
 * POST /api/manual-repayments/[id]/decision
 *
 * The Checker's approve/reject. Approval is the only path that moves money: the
 * repayment is posted through `applyBnplRepayment` inside the same transaction
 * that flips the row to APPROVED, so a repayment is never marked posted without
 * its ledger entries and never posted twice if two checkers click at once.
 *
 * Body: { approved: true } | { approved: false, rejectionReason: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { startOfDay } from 'date-fns';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { handleApiError, validationErrorResponse } from '@/lib/error-utils';
import { sendSms } from '@/lib/sms';
import { applyBnplRepayment } from '@/lib/bnpl-repayment';
import { syncCbsDeletionForBorrower } from '@/actions/cbs-npl';
import {
  CLOSED_LOAN_STATUSES,
  MONEY_EPSILON,
  PAYMENT_SOURCE_LABELS,
  type PaymentSource,
  allocationFor,
  formatBirr,
  getManualRepaymentPolicy,
  loanBalanceSnapshot,
  repaymentStatusLabel,
  retiredReferenceKey,
} from '@/lib/manual-repayment';
import { canDecideRepayment, requestActorContext } from '@/lib/manual-repayment-access';

const decisionSchema = z
  .object({
    approved: z.boolean(),
    rejectionReason: z.string().trim().min(5).max(1000).optional(),
  })
  .refine((v) => v.approved || !!v.rejectionReason, {
    message: 'A reason is required when rejecting a repayment.',
    path: ['rejectionReason'],
  });

/** Posting touches the ledger, the schedule and the loan; give it room. */
const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 15_000 };

export async function POST(req: NextRequest, { params }: { params: any }) {
  const user = await getUserFromSession();
  if (!user || !canDecideRepayment(user)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const { id } = (await params) ?? {};
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { ipAddress, userAgent } = requestActorContext(req);

  try {
    const body = decisionSchema.parse(await req.json());

    const repayment = await prisma.manualRepayment.findUnique({ where: { id } });
    if (!repayment) {
      return NextResponse.json({ error: 'Repayment not found.' }, { status: 404 });
    }
    if (repayment.status !== 'PENDING_APPROVAL') {
      return NextResponse.json(
        { error: `This repayment has already been ${label(repayment.status)}.` },
        { status: 409 },
      );
    }
    // Maker != Checker.
    if (repayment.makerId === user.id) {
      return NextResponse.json(
        { error: 'You cannot approve a repayment you recorded yourself.' },
        { status: 403 },
      );
    }

    if (!body.approved) {
      return await reject(repayment, user, body.rejectionReason!, { ipAddress, userAgent });
    }

    return await approve(repayment, user, { ipAddress, userAgent });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    return handleApiError(error, { operation: 'POST /api/manual-repayments/[id]/decision' });
  }
}

type Repayment = NonNullable<Awaited<ReturnType<typeof prisma.manualRepayment.findUnique>>>;
type Actor = { id: string; fullName: string };
type RequestContext = { ipAddress: string; userAgent: string };

async function reject(
  repayment: Repayment,
  user: Actor,
  rejectionReason: string,
  ctx: RequestContext,
) {
  // Free the reference: the money never reached the loan, and the branch has to
  // be able to re-submit the same genuine bank reference once it is corrected.
  const { count } = await prisma.manualRepayment.updateMany({
    where: { id: repayment.id, status: 'PENDING_APPROVAL' },
    data: {
      status: 'REJECTED',
      checkerId: user.id,
      checkerIp: ctx.ipAddress,
      decidedAt: new Date(),
      rejectionReason,
      referenceKey: retiredReferenceKey(
        repayment.paymentSource,
        repayment.referenceNumber,
        repayment.id,
      ),
    },
  });
  if (count !== 1) {
    return NextResponse.json(
      { error: 'This repayment has already been processed.' },
      { status: 409 },
    );
  }

  await createAuditLog({
    actorId: user.id,
    action: 'MANUAL_REPAYMENT_REJECTED',
    entity: 'ManualRepayment',
    entityId: repayment.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    details: {
      loanId: repayment.loanId,
      borrowerId: repayment.borrowerId,
      amount: repayment.amount,
      referenceNumber: repayment.referenceNumber,
      makerId: repayment.makerId,
      checkerName: user.fullName,
      rejectionReason,
    },
  });

  return NextResponse.json({ ok: true, status: 'REJECTED' });
}

async function approve(repayment: Repayment, user: Actor, ctx: RequestContext) {
  // The maker states when the money moved; penalty accrual and installment status
  // are computed as of that date, not today.
  const paymentDate = startOfDay(new Date(repayment.paymentDate));

  const [loan, taxConfigs, policy] = await Promise.all([
    prisma.loan.findUnique({
      where: { id: repayment.loanId },
      include: {
        product: { include: { provider: { include: { ledgerAccounts: true } } } },
        installments: { orderBy: { installmentNumber: 'asc' } },
        payments: { orderBy: { date: 'asc' } },
      },
    }),
    prisma.tax.findMany({ where: { status: 'ACTIVE' } }),
    getManualRepaymentPolicy(prisma),
  ]);

  if (!loan) return NextResponse.json({ error: 'Loan not found.' }, { status: 404 });
  if (CLOSED_LOAN_STATUSES.includes(loan.repaymentStatus)) {
    return NextResponse.json(
      {
        error:
          'This loan has been settled since the repayment was recorded. Reject the entry and ' +
          'refer the payment for refund.',
      },
      { status: 409 },
    );
  }

  // The balance moves between entry and approval as penalties accrue, so it is
  // re-read here as of the date the money was received. This is the same figure
  // applyBnplRepayment will guard with, so a mismatch is reported here, with a
  // usable message, rather than surfacing as a bare OVERPAYMENT below.
  const balanceNow = loanBalanceSnapshot(
    loan as never,
    loan.product,
    taxConfigs,
    loan.installments as never,
    paymentDate,
  );
  if (balanceNow.payableNow <= MONEY_EPSILON) {
    return NextResponse.json(
      { error: 'This loan has nothing due to settle. Reject the entry.' },
      { status: 409 },
    );
  }
  if (repayment.amount > balanceNow.payableNow + MONEY_EPSILON) {
    return NextResponse.json(
      {
        error:
          `The amount due is now ${formatBirr(balanceNow.payableNow)}, less than the recorded ` +
          `${formatBirr(repayment.amount)}. Reject the entry and have it re-keyed.`,
      },
      { status: 409 },
    );
  }

  const allocation = allocationFor(repayment.amount, balanceNow);
  const sourceLabel =
    PAYMENT_SOURCE_LABELS[repayment.paymentSource as PaymentSource] ?? repayment.paymentSource;

  const posted = await prisma
    .$transaction(async (tx) => {
      // Claim the row first. A second checker approving the same repayment finds
      // zero rows updated, the transaction unwinds, and the ledger entries this
      // block is about to write are never booked twice.
      const claimed = await tx.manualRepayment.updateMany({
        where: { id: repayment.id, status: 'PENDING_APPROVAL' },
        data: {
          status: 'APPROVED',
          checkerId: user.id,
          checkerIp: ctx.ipAddress,
          decidedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw new AlreadyDecidedError();

      const result = await applyBnplRepayment(tx, {
        loan: loan as never,
        taxConfigs: taxConfigs as never,
        paymentAmount: repayment.amount,
        paymentDate,
        describeJournal: (installmentNumber) =>
          installmentNumber === null
            ? `Manual repayment ${repayment.id} — ${sourceLabel} (Ref: ${repayment.referenceNumber})`
            : `Manual repayment ${repayment.id} for installment ${installmentNumber} of loan ${loan.id} — ${sourceLabel} (Ref: ${repayment.referenceNumber})`,
        auditActorId: loan.borrowerId,
        auditDetails: {
          manualRepaymentId: repayment.id,
          referenceNumber: repayment.referenceNumber,
          paymentSource: repayment.paymentSource,
          approvedBy: user.id,
        },
        logLabel: '[MANUAL_REPAYMENT]',
        logId: repayment.id,
      });

      // A checker is standing in front of this, so refuse the approval rather
      // than silently booking nothing the way the gateway callback has to.
      if (result.outcome === 'OVERPAYMENT') {
        throw new OverpaymentError(
          `${formatBirr(repayment.amount)} exceeds the ${result.scope} balance due ` +
            `(${formatBirr(result.due)}). Nothing was recorded.`,
        );
      }

      // Read the loan back inside the transaction so the recorded "after" is the
      // balance this posting actually produced.
      const after = await tx.loan.findUniqueOrThrow({
        where: { id: loan.id },
        select: { repaidAmount: true, repaymentStatus: true },
      });
      const balanceAfter = Math.max(
        0,
        round2(balanceNow.total - repayment.amount),
      );

      // Find what was just booked by the journal description, which carries this
      // repayment's own id. Picking the newest Payment by date would be wrong for
      // a back-dated entry — the row just written would not be the latest one.
      const journal = await tx.journalEntry.findFirst({
        where: { loanId: loan.id, description: { contains: `Manual repayment ${repayment.id}` } },
        orderBy: { id: 'desc' },
        select: { id: true, payment: { select: { id: true } } },
      });

      await tx.manualRepayment.update({
        where: { id: repayment.id },
        data: {
          postedAt: new Date(),
          allocation: JSON.stringify(allocation),
          balanceAfter,
          loanStatusAfter: after.repaymentStatus,
          installmentNumber: result.installmentNumber ?? repayment.installmentNumber,
          paymentId: journal?.payment?.id ?? null,
          journalEntryId: journal?.id ?? null,
        },
      });

      return {
        balanceAfter,
        loanStatusAfter: after.repaymentStatus,
        installmentNumber: result.installmentNumber,
        paymentId: journal?.payment?.id ?? null,
        journalEntryId: journal?.id ?? null,
      };
    }, TRANSACTION_OPTIONS)
    .catch((error) => {
      if (error instanceof AlreadyDecidedError) return 'ALREADY_DECIDED' as const;
      if (error instanceof OverpaymentError) return error;
      throw error;
    });

  if (posted === 'ALREADY_DECIDED') {
    return NextResponse.json(
      { error: 'This repayment has already been processed.' },
      { status: 409 },
    );
  }
  if (posted instanceof OverpaymentError) {
    return NextResponse.json({ error: posted.message }, { status: 409 });
  }

  await createAuditLog({
    actorId: user.id,
    action: 'MANUAL_REPAYMENT_POSTED',
    entity: 'ManualRepayment',
    entityId: repayment.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    details: {
      loanId: repayment.loanId,
      borrowerId: repayment.borrowerId,
      amount: repayment.amount,
      referenceNumber: repayment.referenceNumber,
      paymentSource: repayment.paymentSource,
      paymentDate: paymentDate.toISOString(),
      makerId: repayment.makerId,
      checkerName: user.fullName,
      allocation,
      balanceBefore: balanceNow.total,
      balanceAfter: posted.balanceAfter,
      loanStatusBefore: repayment.loanStatusBefore,
      loanStatusAfter: posted.loanStatusAfter,
      installmentNumber: posted.installmentNumber,
      paymentId: posted.paymentId,
      journalEntryId: posted.journalEntryId,
    },
  });

  // Side effects, both best-effort: neither may undo a posted repayment.
  if (policy.notifyCustomer) {
    void sendSms(
      repayment.borrowerId,
      `Dear customer, a payment of ${formatBirr(repayment.amount)} has been posted to your account. ` +
        `Outstanding balance: ${formatBirr(posted.balanceAfter)}. Thank you.`,
    ).catch((e) => console.error('[manual-repayment] SMS notification failed', e));
  }
  if (posted.loanStatusAfter === 'Paid') {
    void syncCbsDeletionForBorrower(repayment.borrowerId, { source: 'MANUAL', actorId: user.id });
  }

  return NextResponse.json({
    ok: true,
    status: 'APPROVED',
    allocation,
    balanceAfter: posted.balanceAfter,
    repaymentStatus: repaymentStatusLabel(posted.balanceAfter, true),
  });
}

class AlreadyDecidedError extends Error {}
class OverpaymentError extends Error {}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const label = (status: string) => status.replace(/_/g, ' ').toLowerCase();
