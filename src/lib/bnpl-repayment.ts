import { Prisma } from "@prisma/client";
import { startOfDay, isBefore, isEqual, differenceInDays } from "date-fns";
import { calculateTotalRepayable } from "@/lib/loan-calculator";
import { ensureInstallmentRollover } from "@/lib/installment-rollover";
import {
  computeActiveInstallmentDue,
  MONEY_EPSILON,
  LOAN_SETTLE_EPSILON,
} from "@/lib/repayment-due";
import { INSTALLMENT_STATUS, SETTLED_STATUSES } from "@/lib/installment-status";
import { createAuditLog } from "@/lib/audit-log";

/**
 * @fileOverview Applies a confirmed BNPL repayment to a loan.
 *
 * Two callers reach this code: the payment gateway callback (money confirmed by
 * the gateway) and the manual pending-payment resolution (money confirmed by an
 * operator supplying an FT reference, after maker-checker approval). Both must
 * move the exact same amounts through the exact same ledger accounts, so the
 * waterfall lives here once instead of being copied per entry point.
 *
 * The caller owns the surrounding transaction and the claiming of whatever
 * payment intent it is settling; this function only applies the money.
 */

type RepaymentBehavior = "EARLY" | "ON_TIME" | "LATE";

/** Loan loaded with its product, the product's provider ledger accounts, and payments. */
export type LoanForRepayment = {
  id: string;
  borrowerId: string;
  loanAmount: number;
  repaidAmount: number | null;
  dueDate: Date;
  disbursedDate: Date;
  product: {
    provider: {
      id: string;
      ledgerAccounts: Array<{ id: string; type: string; category: string }>;
    };
  };
};

export type ApplyBnplRepaymentParams = {
  loan: LoanForRepayment;
  taxConfigs: unknown[];
  /** Amount confirmed as received. */
  paymentAmount: number;
  /** Value date of the payment; drives penalty accrual and installment status. */
  paymentDate: Date;
  /** Journal entry description, given the installment number when one applies. */
  describeJournal: (installmentNumber: number | null) => string;
  /** Actor recorded on the REPAYMENT_SUCCESS audit log. */
  auditActorId: string;
  /** Extra fields merged into the REPAYMENT_SUCCESS audit details. */
  auditDetails?: Record<string, unknown>;
  /** Prefix for diagnostic logs, e.g. "[PAYMENT_CALLBACK]". */
  logLabel?: string;
  /** Correlation id echoed into diagnostic logs. */
  logId?: string;
};

export type ApplyBnplRepaymentResult =
  | {
      outcome: "APPLIED";
      /** Set when the payment was applied to an installment. */
      installmentNumber: number | null;
    }
  | {
      outcome: "OVERPAYMENT";
      /** Whether the amount exceeded the active installment or the whole loan. */
      scope: "installment" | "loan";
      /** The balance the payment exceeded. */
      due: number;
    };

/**
 * Applies a confirmed repayment: posts the ledger entries, records the Payment,
 * advances the installment schedule and updates the loan.
 *
 * Returns `OVERPAYMENT` (having written nothing) when the amount exceeds what is
 * owed — the caller decides whether that is a failed intent or a hard error.
 * Must be called inside a transaction.
 */
export async function applyBnplRepayment(
  tx: Prisma.TransactionClient,
  {
    loan,
    taxConfigs,
    paymentAmount,
    paymentDate,
    describeJournal,
    auditActorId,
    auditDetails = {},
    logLabel = "[BNPL_REPAYMENT]",
    logId,
  }: ApplyBnplRepaymentParams
): Promise<ApplyBnplRepaymentResult> {
  const loanId = loan.id;
  const provider = loan.product.provider;
  const alreadyRepaid = loan.repaidAmount || 0;

  const totals = calculateTotalRepayable(
    loan as never,
    (loan as any).product,
    taxConfigs as never,
    paymentDate
  );
  const totalDue = totals.total - alreadyRepaid;

  const hasInstallments = await tx.loanInstallment.count({ where: { loanId } });

  let due: any = null;
  let refreshedInstallments: any[] = [];
  if (hasInstallments) {
    // Rollover merge: when an installment is past due, close it and merge
    // its unpaid remainder into the next installment.
    await ensureInstallmentRollover(tx as any, loanId, paymentDate);

    refreshedInstallments = await tx.loanInstallment.findMany({
      where: { loanId },
      orderBy: { installmentNumber: "asc" },
    });

    // Single source of truth for the amount due (fees are billed by
    // entitlement, never re-billed on repeat payments — see repayment-due.ts).
    due = computeActiveInstallmentDue(
      loan as any,
      (loan as any).product,
      taxConfigs as any,
      refreshedInstallments as any,
      paymentDate
    );
    if (!due) {
      // Every installment is settled but a loan-level residual is still
      // owed (e.g. the fee share of merged installments that the old
      // billing logic never collected, on a loan reopened to recover it).
      // Fall through to loan-level settlement so the balance stays
      // collectible instead of throwing.
      console.log(
        `${logLabel} installments settled; collecting loan-level residual`,
        { logId, loanId, totalDue }
      );
    }
  }

  if (due) {
    const activeInstallment = refreshedInstallments.find(
      (i) => i.id === due.installmentId
    )!;

    const penaltyForInstallment = due.penaltyForInstallment;
    const penaltyRemaining = due.penaltyRemaining;
    const serviceFeeDue = due.serviceFeeDue;
    const interestDue = due.interestDue;
    const taxDue = due.taxDue;
    const principalRemaining = due.principalRemaining;
    const totalDueForInstallment = due.total;

    if (paymentAmount > totalDueForInstallment + MONEY_EPSILON) {
      console.error(
        `${logLabel} Overpayment detected. Payment amount (${paymentAmount}) exceeds installment due (${totalDueForInstallment}).`
      );
      return {
        outcome: "OVERPAYMENT",
        scope: "installment",
        due: totalDueForInstallment,
      };
    }

    const journalEntry = await tx.journalEntry.create({
      data: {
        providerId: provider.id,
        loanId: loan.id,
        date: paymentDate,
        description: describeJournal(activeInstallment.installmentNumber),
      },
    });

    const principalReceivable = provider.ledgerAccounts.find(
      (a) => a.category === "Principal" && a.type === "Receivable"
    );
    const penaltyReceivable = provider.ledgerAccounts.find(
      (a) => a.category === "Penalty" && a.type === "Receivable"
    );
    const serviceFeeReceivable = provider.ledgerAccounts.find(
      (a) => a.category === "ServiceFee" && a.type === "Receivable"
    );
    const interestReceivable = provider.ledgerAccounts.find(
      (a) => a.category === "Interest" && a.type === "Receivable"
    );
    const taxReceivable = provider.ledgerAccounts.find(
      (a) => a.category === "Tax" && a.type === "Receivable"
    );
    const principalReceived = provider.ledgerAccounts.find(
      (a) => a.category === "Principal" && a.type === "Received"
    );
    const penaltyReceived = provider.ledgerAccounts.find(
      (a) => a.category === "Penalty" && a.type === "Received"
    );
    const serviceFeeReceived = provider.ledgerAccounts.find(
      (a) => a.category === "ServiceFee" && a.type === "Received"
    );
    const interestReceived = provider.ledgerAccounts.find(
      (a) => a.category === "Interest" && a.type === "Received"
    );
    const taxReceived = provider.ledgerAccounts.find(
      (a) => a.category === "Tax" && a.type === "Received"
    );

    const serviceFeeIncome = provider.ledgerAccounts.find(
      (a) => a.category === "ServiceFee" && a.type === "Income"
    );
    const interestIncome = provider.ledgerAccounts.find(
      (a) => a.category === "Interest" && a.type === "Income"
    );

    if (!principalReceivable || !principalReceived) {
      throw new Error(
        `Ledger accounts not configured for provider ${provider.id}`
      );
    }

    let amountToApply = paymentAmount;

    const penaltyToPay = Math.min(amountToApply, penaltyRemaining);
    if (penaltyToPay > 0 && penaltyReceivable && penaltyReceived) {
      await tx.ledgerAccount.update({
        where: { id: penaltyReceivable.id },
        data: { balance: { decrement: penaltyToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: penaltyReceived.id },
        data: { balance: { increment: penaltyToPay } },
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: penaltyReceivable.id,
            type: "Credit",
            amount: penaltyToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: penaltyReceived.id,
            type: "Debit",
            amount: penaltyToPay,
          },
        ],
      });
      amountToApply -= penaltyToPay;
    }

    const serviceFeeToPay = Math.min(amountToApply, serviceFeeDue);
    if (serviceFeeToPay > 0) {
      if (!serviceFeeReceivable || !serviceFeeReceived || !serviceFeeIncome)
        throw new Error(
          `Service Fee ledger accounts not configured for provider ${provider.id}`
        );
      await tx.ledgerAccount.update({
        where: { id: serviceFeeReceivable.id },
        data: { balance: { decrement: serviceFeeToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: serviceFeeReceived.id },
        data: { balance: { increment: serviceFeeToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: serviceFeeIncome.id },
        data: { balance: { increment: serviceFeeToPay } },
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: serviceFeeReceivable.id,
            type: "Credit",
            amount: serviceFeeToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: serviceFeeReceived.id,
            type: "Debit",
            amount: serviceFeeToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: serviceFeeIncome.id,
            type: "Credit",
            amount: serviceFeeToPay,
          },
        ],
      });
      amountToApply -= serviceFeeToPay;
    }

    const interestToPay = Math.min(amountToApply, interestDue);
    if (interestToPay > 0) {
      if (!interestReceivable || !interestReceived || !interestIncome)
        throw new Error(
          `Interest ledger accounts not configured for provider ${provider.id}`
        );
      await tx.ledgerAccount.update({
        where: { id: interestReceivable.id },
        data: { balance: { decrement: interestToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: interestReceived.id },
        data: { balance: { increment: interestToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: interestIncome.id },
        data: { balance: { increment: interestToPay } },
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: interestReceivable.id,
            type: "Credit",
            amount: interestToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: interestReceived.id,
            type: "Debit",
            amount: interestToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: interestIncome.id,
            type: "Credit",
            amount: interestToPay,
          },
        ],
      });
      amountToApply -= interestToPay;
    }

    const taxToPay = Math.min(amountToApply, taxDue);
    if (taxToPay > 0) {
      if (!taxReceivable || !taxReceived)
        throw new Error(
          `Tax ledger accounts not configured for provider ${provider.id}`
        );
      await tx.ledgerAccount.update({
        where: { id: taxReceivable.id },
        data: { balance: { decrement: taxToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: taxReceived.id },
        data: { balance: { increment: taxToPay } },
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: taxReceivable.id,
            type: "Credit",
            amount: taxToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: taxReceived.id,
            type: "Debit",
            amount: taxToPay,
          },
        ],
      });
      amountToApply -= taxToPay;
    }

    const principalToPay = Math.min(amountToApply, principalRemaining);
    if (principalToPay > 0) {
      await tx.ledgerAccount.update({
        where: { id: principalReceivable.id },
        data: { balance: { decrement: principalToPay } },
      });
      await tx.ledgerAccount.update({
        where: { id: principalReceived.id },
        data: { balance: { increment: principalToPay } },
      });
      await tx.ledgerEntry.createMany({
        data: [
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: principalReceivable.id,
            type: "Credit",
            amount: principalToPay,
          },
          {
            journalEntryId: journalEntry.id,
            ledgerAccountId: principalReceived.id,
            type: "Debit",
            amount: principalToPay,
          },
        ],
      });
      amountToApply -= principalToPay;
    }

    await tx.payment.create({
      data: {
        loanId,
        installmentId: activeInstallment.id,
        amount: paymentAmount,
        date: paymentDate,
        outstandingBalanceBeforePayment: totalDueForInstallment,
        journalEntryId: journalEntry.id,
      },
    });

    // Settled when at most rounding dust (< 1 cent) remains — quotes are
    // rounded to the cent, so demanding exact float equality used to leave
    // installments open by fractions of a cent forever.
    const isInstallmentFullyPaid =
      principalRemaining - principalToPay <= MONEY_EPSILON &&
      penaltyRemaining - penaltyToPay <= MONEY_EPSILON;

    // On settlement, snap paidAmount to the exact amount owed so no dust
    // survives into rollovers or later quotes.
    const newPaidAmount = isInstallmentFullyPaid
      ? (activeInstallment.amount || 0) + penaltyForInstallment
      : (activeInstallment.paidAmount || 0) + penaltyToPay + principalToPay;

    await tx.loanInstallment.update({
      where: { id: activeInstallment.id },
      data: {
        paidAmount: newPaidAmount,
        paidAt: paymentDate,
        status: isInstallmentFullyPaid
          ? INSTALLMENT_STATUS.Paid
          : differenceInDays(paymentDate, activeInstallment.dueDate) > 0
            ? INSTALLMENT_STATUS.Overdue
            : INSTALLMENT_STATUS.Pending,
        penaltyAmount: penaltyForInstallment,
        isActive: !isInstallmentFullyPaid,
      },
    });

    await tx.loan.update({
      where: { id: loanId },
      data: { repaidAmount: alreadyRepaid + paymentAmount },
    });

    if (isInstallmentFullyPaid) {
      const nextPayable = await tx.loanInstallment.findFirst({
        where: {
          loanId,
          installmentNumber: { gt: activeInstallment.installmentNumber },
          status: { notIn: SETTLED_STATUSES },
          amount: { gt: 0 },
        },
        orderBy: { installmentNumber: "asc" },
      });
      if (nextPayable) {
        await tx.loanInstallment.update({
          where: { id: nextPayable.id },
          data: { isActive: true },
        });
      } else {
        // Last installment settled — but only mark the LOAN paid when the
        // money received actually covers the total repayable. (Loans used
        // to be marked Paid while the fee share of merged installments was
        // never billed.)
        const newRepaidTotal = alreadyRepaid + paymentAmount;
        if (newRepaidTotal >= totals.total - LOAN_SETTLE_EPSILON) {
          const today = startOfDay(new Date());
          const loanDue = startOfDay(loan.dueDate);
          const behavior: RepaymentBehavior = isBefore(today, loanDue)
            ? "EARLY"
            : isEqual(today, loanDue)
              ? "ON_TIME"
              : "LATE";
          await tx.loan.update({
            where: { id: loanId },
            data: { repaymentStatus: "Paid", repaymentBehavior: behavior },
          });
        } else {
          console.error(
            `${logLabel} all installments settled but loan under-collected; leaving Unpaid`,
            {
              logId,
              loanId,
              repaid: newRepaidTotal,
              expected: totals.total,
            }
          );
        }
      }
    }

    await createAuditLog({
      actorId: auditActorId,
      action: "REPAYMENT_SUCCESS",
      entity: "LOAN",
      entityId: loan.id,
      details: {
        ...auditDetails,
        amount: paymentAmount,
        installmentNumber: activeInstallment.installmentNumber,
      },
    });

    console.log(`${logLabel} installment repayment completed`, {
      logId,
      loanId,
      amount: paymentAmount,
    });

    return {
      outcome: "APPLIED",
      installmentNumber: activeInstallment.installmentNumber,
    };
  }

  // Loan-level settlement: the waterfall below caps each component at what is
  // owed, so an excess would vanish into nothing while still being added to
  // repaidAmount. Refuse it instead.
  if (paymentAmount > totalDue + MONEY_EPSILON) {
    console.error(
      `${logLabel} Overpayment detected. Payment amount (${paymentAmount}) exceeds loan-level balance due (${totalDue}).`
    );
    return { outcome: "OVERPAYMENT", scope: "loan", due: totalDue };
  }

  const journalEntry = await tx.journalEntry.create({
    data: {
      providerId: provider.id,
      loanId: loan.id,
      date: paymentDate,
      description: describeJournal(null),
    },
  });

  // Find provider ledger accounts for receivable/received
  const principalReceivable = provider.ledgerAccounts.find(
    (a) => a.category === "Principal" && a.type === "Receivable"
  );
  const interestReceivable = provider.ledgerAccounts.find(
    (a) => a.category === "Interest" && a.type === "Receivable"
  );
  const penaltyReceivable = provider.ledgerAccounts.find(
    (a) => a.category === "Penalty" && a.type === "Receivable"
  );
  const serviceFeeReceivable = provider.ledgerAccounts.find(
    (a) => a.category === "ServiceFee" && a.type === "Receivable"
  );
  const taxReceivable = provider.ledgerAccounts.find(
    (a) => a.category === "Tax" && a.type === "Receivable"
  );

  const principalReceived = provider.ledgerAccounts.find(
    (a) => a.category === "Principal" && a.type === "Received"
  );
  const interestReceived = provider.ledgerAccounts.find(
    (a) => a.category === "Interest" && a.type === "Received"
  );
  const penaltyReceived = provider.ledgerAccounts.find(
    (a) => a.category === "Penalty" && a.type === "Received"
  );
  const serviceFeeReceived = provider.ledgerAccounts.find(
    (a) => a.category === "ServiceFee" && a.type === "Received"
  );
  const taxReceived = provider.ledgerAccounts.find(
    (a) => a.category === "Tax" && a.type === "Received"
  );

  const interestIncome = provider.ledgerAccounts.find(
    (a) => a.category === "Interest" && a.type === "Income"
  );
  const penaltyIncome = provider.ledgerAccounts.find(
    (a) => a.category === "Penalty" && a.type === "Income"
  );
  const serviceFeeIncome = provider.ledgerAccounts.find(
    (a) => a.category === "ServiceFee" && a.type === "Income"
  );

  if (
    !principalReceivable ||
    !interestReceivable ||
    !penaltyReceivable ||
    !serviceFeeReceivable ||
    !taxReceivable ||
    !principalReceived ||
    !interestReceived ||
    !penaltyReceived ||
    !serviceFeeReceived ||
    !taxReceived
  ) {
    throw new Error(
      `One or more ledger accounts not found for provider ${provider.id}`
    );
  }

  // Prepare ledger entry creations
  const ledgerEntryCreates: Array<{
    journalEntryId: string;
    ledgerAccountId: string;
    type: string;
    amount: number;
  }> = [];

  // Apply payment in order: Penalty -> ServiceFee -> Interest -> Principal
  let amountToApply = paymentAmount;

  const alreadyPaidPenalty = Math.min(totals.penalty, alreadyRepaid);
  const alreadyPaidServiceFee = Math.min(
    totals.serviceFee,
    Math.max(0, alreadyRepaid - totals.penalty)
  );
  const alreadyPaidInterest = Math.min(
    totals.interest,
    Math.max(0, alreadyRepaid - totals.penalty - totals.serviceFee)
  );
  const alreadyPaidTax = Math.min(
    totals.tax,
    Math.max(
      0,
      alreadyRepaid - totals.penalty - totals.serviceFee - totals.interest
    )
  );
  const alreadyPaidPrincipal = Math.min(
    totals.principal,
    Math.max(
      0,
      alreadyRepaid -
        totals.penalty -
        totals.serviceFee -
        totals.interest -
        totals.tax
    )
  );

  const penaltyDue = Math.max(0, totals.penalty - alreadyPaidPenalty);
  const penaltyToPay = Math.min(amountToApply, penaltyDue);
  if (penaltyToPay > 0) {
    await tx.ledgerAccount.update({
      where: { id: penaltyReceivable.id },
      data: { balance: { decrement: penaltyToPay } },
    });
    await tx.ledgerAccount.update({
      where: { id: penaltyReceived.id },
      data: { balance: { increment: penaltyToPay } },
    });
    if (!penaltyIncome)
      throw new Error(
        `Penalty Income ledger account not found for provider ${provider.id}`
      );
    await tx.ledgerAccount.update({
      where: { id: penaltyIncome.id },
      data: { balance: { increment: penaltyToPay } },
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: penaltyReceivable.id,
      type: "Credit",
      amount: penaltyToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: penaltyReceived.id,
      type: "Debit",
      amount: penaltyToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: penaltyIncome.id,
      type: "Credit",
      amount: penaltyToPay,
    });
    amountToApply -= penaltyToPay;
  }

  const serviceFeeDue = Math.max(0, totals.serviceFee - alreadyPaidServiceFee);
  const serviceFeeToPay = Math.min(amountToApply, serviceFeeDue);
  if (serviceFeeToPay > 0) {
    await tx.ledgerAccount.update({
      where: { id: serviceFeeReceivable.id },
      data: { balance: { decrement: serviceFeeToPay } },
    });
    await tx.ledgerAccount.update({
      where: { id: serviceFeeReceived.id },
      data: { balance: { increment: serviceFeeToPay } },
    });
    if (!serviceFeeIncome)
      throw new Error(
        `Service Fee Income ledger account not found for provider ${provider.id}`
      );
    await tx.ledgerAccount.update({
      where: { id: serviceFeeIncome.id },
      data: { balance: { increment: serviceFeeToPay } },
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: serviceFeeReceivable.id,
      type: "Credit",
      amount: serviceFeeToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: serviceFeeReceived.id,
      type: "Debit",
      amount: serviceFeeToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: serviceFeeIncome.id,
      type: "Credit",
      amount: serviceFeeToPay,
    });
    amountToApply -= serviceFeeToPay;
  }

  const interestDue = Math.max(0, totals.interest - alreadyPaidInterest);
  const interestToPay = Math.min(amountToApply, interestDue);
  if (interestToPay > 0) {
    await tx.ledgerAccount.update({
      where: { id: interestReceivable.id },
      data: { balance: { decrement: interestToPay } },
    });
    await tx.ledgerAccount.update({
      where: { id: interestReceived.id },
      data: { balance: { increment: interestToPay } },
    });
    if (!interestIncome)
      throw new Error(
        `Interest Income ledger account not found for provider ${provider.id}`
      );
    await tx.ledgerAccount.update({
      where: { id: interestIncome.id },
      data: { balance: { increment: interestToPay } },
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: interestReceivable.id,
      type: "Credit",
      amount: interestToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: interestReceived.id,
      type: "Debit",
      amount: interestToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: interestIncome.id,
      type: "Credit",
      amount: interestToPay,
    });
    amountToApply -= interestToPay;
  }

  const taxDue = Math.max(0, totals.tax - alreadyPaidTax);
  const taxToPay = Math.min(amountToApply, taxDue);
  if (taxToPay > 0) {
    await tx.ledgerAccount.update({
      where: { id: taxReceivable.id },
      data: { balance: { decrement: taxToPay } },
    });
    await tx.ledgerAccount.update({
      where: { id: taxReceived.id },
      data: { balance: { increment: taxToPay } },
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: taxReceivable.id,
      type: "Credit",
      amount: taxToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: taxReceived.id,
      type: "Debit",
      amount: taxToPay,
    });
    amountToApply -= taxToPay;
  }

  const principalDue = Math.max(0, totals.principal - alreadyPaidPrincipal);
  const principalToPay = Math.min(amountToApply, principalDue);
  if (principalToPay > 0) {
    await tx.ledgerAccount.update({
      where: { id: principalReceivable.id },
      data: { balance: { decrement: principalToPay } },
    });
    await tx.ledgerAccount.update({
      where: { id: principalReceived.id },
      data: { balance: { increment: principalToPay } },
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: principalReceivable.id,
      type: "Credit",
      amount: principalToPay,
    });
    ledgerEntryCreates.push({
      journalEntryId: journalEntry.id,
      ledgerAccountId: principalReceived.id,
      type: "Debit",
      amount: principalToPay,
    });
    amountToApply -= principalToPay;
  }

  if (ledgerEntryCreates.length > 0) {
    await tx.ledgerEntry.createMany({ data: ledgerEntryCreates });
  }

  await tx.payment.create({
    data: {
      loanId,
      amount: paymentAmount,
      date: paymentDate,
      outstandingBalanceBeforePayment: totalDue,
      journalEntryId: journalEntry.id,
    },
  });

  const newRepaidAmount = alreadyRepaid + paymentAmount;
  const isFullyPaid = newRepaidAmount >= totals.total - LOAN_SETTLE_EPSILON;
  let repaymentBehavior: RepaymentBehavior | null = null;

  if (isFullyPaid) {
    const today = startOfDay(new Date());
    const dueDate = startOfDay(loan.dueDate);
    if (isBefore(today, dueDate)) repaymentBehavior = "EARLY";
    else if (isEqual(today, dueDate)) repaymentBehavior = "ON_TIME";
    else repaymentBehavior = "LATE";
  }

  await tx.loan.update({
    where: { id: loanId },
    data: {
      repaidAmount: newRepaidAmount,
      repaymentStatus: isFullyPaid ? "Paid" : "Unpaid",
      ...(repaymentBehavior && { repaymentBehavior }),
    },
  });

  await createAuditLog({
    actorId: auditActorId,
    action: "REPAYMENT_SUCCESS",
    entity: "LOAN",
    entityId: loan.id,
    details: {
      ...auditDetails,
      amount: paymentAmount,
    },
  });

  console.log(`${logLabel} normal repayment completed`, {
    logId,
    loanId,
    amount: paymentAmount,
  });

  return { outcome: "APPLIED", installmentNumber: null };
}
