/**
 * POST /api/manual-repayments/[id]/reversal
 *
 * A posted repayment is never edited; an error is corrected by an approved
 * reversal, which carries its own maker-checker pair:
 *
 *   action=request  APPROVED         -> PENDING_REVERSAL  (reason mandatory)
 *   action=approve  PENDING_REVERSAL -> REVERSED          (compensating entries)
 *   action=reject   PENDING_REVERSAL -> APPROVED          (posting stands)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { handleApiError, validationErrorResponse } from '@/lib/error-utils';
import { ALLOCATION_BUCKETS, retiredReferenceKey } from '@/lib/manual-repayment';
import { reverseManualRepayment } from '@/lib/manual-repayment-reversal';
import {
  canDecideRepayment,
  canRequestReversal,
  requestActorContext,
} from '@/lib/manual-repayment-access';

const schema = z.object({
  action: z.enum(['request', 'approve', 'reject']),
  reason: z.string().trim().min(5).max(1000),
});

const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 15_000 };

export async function POST(req: NextRequest, { params }: { params: any }) {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = (await params) ?? {};
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { ipAddress, userAgent } = requestActorContext(req);

  try {
    const { action, reason } = schema.parse(await req.json());

    const repayment = await prisma.manualRepayment.findUnique({ where: { id } });
    if (!repayment) return NextResponse.json({ error: 'Repayment not found.' }, { status: 404 });

    if (action === 'request') {
      if (!canRequestReversal(user)) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
      }
      if (repayment.status !== 'APPROVED') {
        return NextResponse.json(
          { error: 'Only a posted repayment can be reversed.' },
          { status: 409 },
        );
      }

      const { count } = await prisma.manualRepayment.updateMany({
        where: { id, status: 'APPROVED' },
        data: {
          status: 'PENDING_REVERSAL',
          reversalReason: reason,
          reversalRequestedById: user.id,
          reversalRequestedAt: new Date(),
        },
      });
      if (count !== 1) {
        return NextResponse.json(
          { error: 'This repayment has already changed state.' },
          { status: 409 },
        );
      }

      await createAuditLog({
        actorId: user.id,
        action: 'MANUAL_REPAYMENT_REVERSAL_REQUESTED',
        entity: 'ManualRepayment',
        entityId: id,
        ipAddress,
        userAgent,
        details: {
          loanId: repayment.loanId,
          amount: repayment.amount,
          referenceNumber: repayment.referenceNumber,
          reason,
          requestedBy: user.fullName,
        },
      });

      return NextResponse.json({ ok: true, status: 'PENDING_REVERSAL' });
    }

    // Both remaining actions are the Checker's.
    if (!canDecideRepayment(user)) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
    if (repayment.status !== 'PENDING_REVERSAL') {
      return NextResponse.json(
        { error: 'No reversal is pending on this repayment.' },
        { status: 409 },
      );
    }
    // The reversal needs a second pair of eyes, exactly as the posting did.
    if (repayment.reversalRequestedById === user.id) {
      return NextResponse.json(
        { error: 'You cannot approve a reversal you requested yourself.' },
        { status: 403 },
      );
    }

    if (action === 'reject') {
      const { count } = await prisma.manualRepayment.updateMany({
        where: { id, status: 'PENDING_REVERSAL' },
        data: {
          status: 'APPROVED',
          reversalReason: null,
          reversalRequestedById: null,
          reversalRequestedAt: null,
        },
      });
      if (count !== 1) {
        return NextResponse.json(
          { error: 'This repayment has already changed state.' },
          { status: 409 },
        );
      }

      await createAuditLog({
        actorId: user.id,
        action: 'MANUAL_REPAYMENT_REVERSAL_DECLINED',
        entity: 'ManualRepayment',
        entityId: id,
        ipAddress,
        userAgent,
        details: { loanId: repayment.loanId, amount: repayment.amount, reason },
      });

      return NextResponse.json({ ok: true, status: 'APPROVED' });
    }

    const result = await prisma
      .$transaction(async (tx) => {
        const claimed = await tx.manualRepayment.updateMany({
          where: { id, status: 'PENDING_REVERSAL' },
          data: {
            status: 'REVERSED',
            reversedById: user.id,
            reversedAt: new Date(),
            // The reversed slip's reference is freed so a corrected entry can use it.
            referenceKey: retiredReferenceKey(
              repayment.paymentSource,
              repayment.referenceNumber,
              repayment.id,
            ),
          },
        });
        if (claimed.count !== 1) throw new AlreadyReversedError();

        const applied = appliedAmounts(repayment);
        const reversal = await reverseManualRepayment(tx, {
          loanId: repayment.loanId,
          paymentId: repayment.paymentId,
          journalEntryId: repayment.journalEntryId,
          amount: applied.total,
          installmentAmount: applied.installment,
          reason,
        });

        await tx.manualRepayment.update({
          where: { id },
          data: {
            reversalJournalEntryId: reversal.journalEntryId,
            reversalReason: reason,
            balanceAfter: reversal.balanceAfter,
            loanStatusAfter: reversal.loanStatusAfter,
          },
        });

        return reversal;
      }, TRANSACTION_OPTIONS)
      .catch((error) => {
        if (error instanceof AlreadyReversedError) return null;
        throw error;
      });

    if (!result) {
      return NextResponse.json(
        { error: 'This repayment has already been reversed.' },
        { status: 409 },
      );
    }

    await createAuditLog({
      actorId: user.id,
      action: 'MANUAL_REPAYMENT_REVERSED',
      entity: 'ManualRepayment',
      entityId: id,
      ipAddress,
      userAgent,
      details: {
        loanId: repayment.loanId,
        borrowerId: repayment.borrowerId,
        amount: repayment.amount,
        referenceNumber: repayment.referenceNumber,
        reason,
        requestedBy: repayment.reversalRequestedById,
        approvedBy: user.fullName,
        reversalJournalEntryId: result.journalEntryId,
        balanceAfter: result.balanceAfter,
      },
    });

    return NextResponse.json({ ok: true, status: 'REVERSED', balanceAfter: result.balanceAfter });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    return handleApiError(error, { operation: 'POST /api/manual-repayments/[id]/reversal' });
  }
}

class AlreadyReversedError extends Error {}

/**
 * What the approval booked, read back from the allocation it stored.
 * `applyBnplRepayment` posts the full amount or nothing, so the total equals the
 * recorded amount; the split matters only for how much comes off the schedule.
 */
function appliedAmounts(repayment: { amount: number; allocation: string | null }) {
  let parsed: Record<string, number> | null = null;
  try {
    parsed = repayment.allocation ? JSON.parse(repayment.allocation) : null;
  } catch {
    parsed = null;
  }
  if (!parsed) return { total: repayment.amount, installment: repayment.amount };

  const value = (key: string) => Math.max(0, Number(parsed?.[key] ?? 0));
  const total = ALLOCATION_BUCKETS.reduce((sum, bucket) => sum + value(bucket), 0);
  // Only penalty and principal ever moved an installment's paidAmount.
  return { total, installment: value('PENALTY') + value('PRINCIPAL') };
}
