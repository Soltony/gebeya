import { PrismaClient } from "@prisma/client";
import { startOfDay } from "date-fns";
import { getAsOfDate } from "./date-utils";
import { INSTALLMENT_STATUS, isPaidStatus, isSettledStatus } from "./installment-status";
import { MONEY_EPSILON } from "./repayment-due";

/**
 * Overdue Installment Merging Logic
 *
 * When an installment's due date passes and it is unpaid, the system should:
 * 1. Clear (close) the overdue installment (set status to 'Merged', amount to 0)
 * 2. Merge its UNPAID REMAINDER into the next installment
 * 3. Make the next installment the active installment
 *
 * This process repeats sequentially for any number of installments (n).
 *
 * Correctness rules (each guards against a production incident):
 * - Status comparisons are case-insensitive: the DB holds 'Paid'/'Merged'
 *   while older code compared against 'PAID'/'MERGED' and consequently
 *   merged away installments that were already paid.
 * - An overdue installment whose principal is covered (within MONEY_EPSILON)
 *   is marked Paid, never Merged — rounding dust must not roll forward.
 * - The close-and-merge pair is guarded by a conditional update on the
 *   current row's amount+status: two concurrent page loads used to both
 *   apply the merge, double-billing the successor.
 *
 * IMPORTANT: This only affects installment status/amount tracking.
 * Loan-level interest (daily fee) calculation is NOT modified.
 */

export interface RolloverResult {
  updated: boolean;
  mergedCount: number;
  activeInstallmentId: string | null;
}

type PrismaLike =
  | PrismaClient
  | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Ensures overdue installments are rolled over (merged) into the next installment.
 *
 * @param prisma - Prisma client instance (can be transaction client)
 * @param loanId - The loan ID to process
 * @param asOfDate - Optional date to use for determining overdue status (defaults to current date)
 * @returns RolloverResult with information about what was updated
 */
export async function ensureInstallmentRollover(
  prisma: PrismaLike,
  loanId: string,
  asOfDate?: Date
): Promise<RolloverResult> {
  const rawAsOfDate = asOfDate ?? getAsOfDate();
  const today = startOfDay(rawAsOfDate);

  const installments = await (prisma as any).loanInstallment.findMany({
    where: { loanId },
    orderBy: { installmentNumber: "asc" },
  });

  if (installments.length === 0) {
    return { updated: false, mergedCount: 0, activeInstallmentId: null };
  }

  let mergedCount = 0;
  let updated = false;

  for (let i = 0; i < installments.length - 1; i++) {
    const current = installments[i];
    const next = installments[i + 1];
    const currentDueDate = startOfDay(new Date(current.dueDate));

    if (!(currentDueDate < today)) continue;
    if (isSettledStatus(current.status)) continue;
    if ((current.amount || 0) <= 0) continue;

    const paidAmount = current.paidAmount || 0;
    const remainingAmount = Math.max(0, (current.amount || 0) - paidAmount);

    // Fully covered (or only rounding dust left): close as Paid, do not merge.
    if (remainingAmount <= MONEY_EPSILON) {
      const res = await (prisma as any).loanInstallment.updateMany({
        where: { id: current.id, status: current.status },
        data: {
          status: INSTALLMENT_STATUS.Paid,
          paidAmount: current.amount,
          isActive: false,
          paidAt: current.paidAt ?? today,
        },
      });
      if (res.count === 1) {
        current.status = INSTALLMENT_STATUS.Paid;
        current.isActive = false;
        updated = true;
      }
      continue;
    }

    // Next installment already paid: nothing to merge into; keep current active.
    if (isPaidStatus(next.status)) {
      if (!current.isActive) {
        await (prisma as any).loanInstallment.update({
          where: { id: current.id },
          data: { isActive: true },
        });
        current.isActive = true;
        updated = true;
      }
      continue;
    }

    // Close the overdue installment. The conditional `amount` match makes the
    // merge idempotent under concurrency: a racing rollover that already
    // closed this row (amount -> 0) causes count === 0 and we skip the
    // successor update instead of double-billing it.
    const closed = await (prisma as any).loanInstallment.updateMany({
      where: {
        id: current.id,
        amount: current.amount,
        status: { notIn: [INSTALLMENT_STATUS.Paid, INSTALLMENT_STATUS.Merged] },
      },
      data: {
        status: INSTALLMENT_STATUS.Merged,
        isActive: false,
        amount: 0,
      },
    });

    if (closed.count !== 1) continue;

    // Merge only the unpaid remainder (and accrued penalty) into the successor.
    const mergedAmount = remainingAmount + (next.amount || 0);
    const mergedPenalty = (current.penaltyAmount || 0) + (next.penaltyAmount || 0);

    await (prisma as any).loanInstallment.update({
      where: { id: next.id },
      data: {
        amount: mergedAmount,
        penaltyAmount: mergedPenalty,
        isActive: true,
      },
    });

    // Update in-memory values so a cascading rollover in the same loop sees
    // the merged state.
    next.amount = mergedAmount;
    next.penaltyAmount = mergedPenalty;
    next.isActive = true;
    current.amount = 0;
    current.status = INSTALLMENT_STATUS.Merged;
    current.isActive = false;

    mergedCount++;
    updated = true;
  }

  // Find the active installment after rollover from the in-memory state.
  const activeInstallment = installments.find(
    (i: any) => i.isActive && !isSettledStatus(i.status)
  );

  // If no active installment found (e.g. all earlier ones merged), activate
  // the first open installment.
  if (!activeInstallment) {
    const firstOpen = installments.find(
      (i: any) => !isSettledStatus(i.status) && (i.amount || 0) > 0
    );
    if (firstOpen && !firstOpen.isActive) {
      await (prisma as any).loanInstallment.update({
        where: { id: firstOpen.id },
        data: { isActive: true },
      });
      return {
        updated: true,
        mergedCount,
        activeInstallmentId: firstOpen.id,
      };
    }
    return { updated, mergedCount, activeInstallmentId: firstOpen?.id ?? null };
  }

  return {
    updated,
    mergedCount,
    activeInstallmentId: activeInstallment?.id ?? null,
  };
}

/**
 * Batch process rollover for multiple loans.
 * Useful for dashboard/history pages that need to ensure all loans are up-to-date.
 *
 * @param prisma - Prisma client instance
 * @param loanIds - Array of loan IDs to process
 * @param asOfDate - Optional date to use for determining overdue status
 */
export async function ensureInstallmentRolloverBatch(
  prisma: PrismaClient,
  loanIds: string[],
  asOfDate?: Date
): Promise<void> {
  for (const loanId of loanIds) {
    await ensureInstallmentRollover(prisma, loanId, asOfDate);
  }
}
