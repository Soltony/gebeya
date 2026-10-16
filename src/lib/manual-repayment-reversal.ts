/**
 * Backs a posted manual repayment out of the ledger.
 *
 * A posted repayment is never edited; an error is corrected by an approved
 * reversal, which books a mirrored journal rather than deleting the original —
 * the general ledger keeps both halves of the correction.
 *
 * There is no inverse of `applyBnplRepayment`, so this is the one piece of
 * posting logic the module owns. It is deliberately narrow: it only ever unwinds
 * a journal this module wrote, whose entries and amount it knows.
 */

import type { Prisma } from '@prisma/client';
import { INSTALLMENT_STATUS, isMergedStatus } from './installment-status';
import { roundCurrency } from './interest-accrual';

export interface ReverseResult {
  journalEntryId: string;
  /** What the loan owes once the repayment is off it. */
  balanceAfter: number;
  loanStatusAfter: string;
}

export async function reverseManualRepayment(
  tx: Prisma.TransactionClient,
  params: {
    loanId: string;
    paymentId: string | null;
    journalEntryId: string | null;
    /**
     * What the posting actually applied. `applyBnplRepayment` books the full
     * amount or nothing, so for this module it equals the recorded amount — it
     * is passed explicitly rather than re-derived so the caller stays in charge.
     */
    amount: number;
    /** Penalty + principal share, which is all the schedule ever tracked. */
    installmentAmount: number;
    reason: string;
  },
): Promise<ReverseResult> {
  const { loanId, paymentId, journalEntryId, reason } = params;
  const amount = roundCurrency(Number(params.amount));
  const installmentAmount = roundCurrency(Number(params.installmentAmount));

  const loan = await tx.loan.findUnique({
    where: { id: loanId },
    include: { product: { include: { provider: { select: { id: true } } } } },
  });
  if (!loan) throw new Error(`Loan ${loanId} not found.`);
  const providerId = loan.product?.provider?.id;
  if (!providerId) throw new Error(`No provider configured for loan ${loanId}.`);

  const original = journalEntryId
    ? await tx.journalEntry.findUnique({
        where: { id: journalEntryId },
        include: { entries: true },
      })
    : null;

  const reversalJournal = await tx.journalEntry.create({
    data: {
      providerId,
      loanId,
      date: new Date(),
      description: `Reversal: manual repayment ${paymentId ?? journalEntryId ?? ''} — ${reason}`,
    },
  });

  for (const entry of original?.entries ?? []) {
    const mirrored = entry.type === 'Debit' ? 'Credit' : 'Debit';
    await tx.ledgerEntry.create({
      data: {
        journalEntryId: reversalJournal.id,
        ledgerAccountId: entry.ledgerAccountId,
        type: mirrored,
        amount: entry.amount,
      },
    });
    // A Debit raised the balance when it was posted, so unwinding it lowers it.
    await tx.ledgerAccount.update({
      where: { id: entry.ledgerAccountId },
      data: { balance: { increment: entry.type === 'Debit' ? -entry.amount : entry.amount } },
    });
  }

  // The Payment row has to go: interest accrues on the declining balance, so a
  // payment left in place would keep suppressing interest it no longer paid.
  if (paymentId) {
    await tx.payment.deleteMany({ where: { id: paymentId } });
  }

  await tx.loan.update({
    where: { id: loanId },
    data: {
      repaidAmount: roundCurrency(Math.max(0, Number(loan.repaidAmount ?? 0) - amount)),
      repaymentStatus: 'Unpaid',
      repaymentBehavior: null,
    },
  });

  await reopenInstallments(tx, loanId, installmentAmount);

  const [refreshed, taxConfigs] = await Promise.all([
    tx.loan.findUnique({
      where: { id: loanId },
      include: { product: true, payments: { orderBy: { date: 'asc' } } },
    }),
    tx.tax.findMany({ where: { status: 'ACTIVE' } }),
  ]);

  // Imported lazily: computeLoanLevelDue pulls in the calculator, and keeping the
  // import at call site keeps this module free of a cycle through loan-calculator.
  const { computeLoanLevelDue } = await import('./repayment-due');
  const balanceAfter = refreshed
    ? computeLoanLevelDue(refreshed as never, refreshed.product, taxConfigs as never, new Date())
    : 0;

  return { journalEntryId: reversalJournal.id, balanceAfter, loanStatusAfter: 'Unpaid' };
}

/**
 * Takes `amount` back off the installment schedule, newest-paid first, mirroring
 * the oldest-first order the posting applied it in, then re-activates the
 * earliest installment that still owes money.
 *
 * A MERGED installment is left alone: the rollover folded it forward and its
 * money lives on the installment that absorbed it, so re-opening it here would
 * resurrect a schedule row that should stay closed.
 */
async function reopenInstallments(tx: Prisma.TransactionClient, loanId: string, amount: number) {
  const installments = await tx.loanInstallment.findMany({
    where: { loanId },
    orderBy: { installmentNumber: 'desc' },
  });

  let money = amount;
  for (const inst of installments) {
    if (money <= 0) break;
    if (isMergedStatus(inst.status)) continue;
    const paid = Number(inst.paidAmount ?? 0);
    if (paid <= 0) continue;

    const take = roundCurrency(Math.min(money, paid));
    const newPaid = roundCurrency(paid - take);
    await tx.loanInstallment.update({
      where: { id: inst.id },
      data: {
        paidAmount: newPaid,
        status: INSTALLMENT_STATUS.Pending,
        isActive: false,
        ...(newPaid <= 0 ? { paidAt: null } : {}),
      },
    });
    money = roundCurrency(money - take);
  }

  // Exactly one installment is active again: the earliest that still owes money.
  const next = await tx.loanInstallment.findFirst({
    where: {
      loanId,
      status: { notIn: [INSTALLMENT_STATUS.Paid, INSTALLMENT_STATUS.Merged] },
      amount: { gt: 0 },
    },
    orderBy: { installmentNumber: 'asc' },
  });
  if (next) {
    await tx.loanInstallment.update({ where: { id: next.id }, data: { isActive: true } });
  }
}
