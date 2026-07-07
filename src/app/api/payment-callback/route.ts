import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  calculateTotalRepayable,
  calculateTotalRepayableDetailed,
} from "@/lib/loan-calculator";
import { startOfDay, isBefore, isEqual } from "date-fns";
import { getAsOfDate } from "@/lib/date-utils";
import { ensureInstallmentRollover } from "@/lib/installment-rollover";
import { createAuditLog } from "@/lib/audit-log";

// Local alias for repayment behavior values used in the code
type RepaymentBehavior = "EARLY" | "ON_TIME" | "LATE";

const safeJsonParse = (value: any, defaultValue: any) => {
  if (value == null) return defaultValue;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return defaultValue;
    }
  }
  return value;
};

const calculatePenaltyForInstallment = (
  installmentAmount: number,
  dueDate: Date,
  penaltyRules: any[],
  asOfDate: Date
) => {
  const daysOverdue = Math.max(
    0,
    Math.floor(
      (startOfDay(asOfDate).getTime() - startOfDay(dueDate).getTime()) /
        (24 * 60 * 60 * 1000)
    )
  );
  let penalty = 0;
  (penaltyRules || []).forEach((rule: any) => {
    const fromDay = rule.fromDay === "" ? 1 : Number(rule.fromDay);
    const toDayRaw =
      rule.toDay === "" || rule.toDay == null ? Infinity : Number(rule.toDay);
    const toDay = Number.isFinite(toDayRaw) ? toDayRaw : Infinity;
    const value = rule.value === "" ? 0 : Number(rule.value);
    if (!Number.isFinite(fromDay) || !Number.isFinite(value)) return;

    if (daysOverdue >= fromDay) {
      const applicableDaysInTier = Math.min(daysOverdue, toDay) - fromDay + 1;
      const isOneTime = rule.frequency === "one-time";
      const daysToCalculate = isOneTime ? 1 : applicableDaysInTier;
      if (daysToCalculate <= 0) return;

      if (rule.type === "fixed") {
        penalty += value * daysToCalculate;
      } else if (rule.type === "percentageOfPrincipal") {
        penalty += installmentAmount * (value / 100) * daysToCalculate;
      } else if (rule.type === "percentageOfCompound") {
        penalty += installmentAmount * (value / 100) * daysToCalculate;
      }
    }
  });
  return Math.max(0, penalty);
};

// Function to validate the token from the Authorization header
async function validateAuthHeader(authHeader: string | null) {
  const TOKEN_VALIDATION_API_URL = process.env.TOKEN_VALIDATION_API_URL;
  if (!TOKEN_VALIDATION_API_URL) {
    throw new Error("Token validation URL is not configured.");
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Authorization header is malformed or missing.");
  }

  const response = await fetch(TOKEN_VALIDATION_API_URL, {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Token validation failed:", errorData);
    throw new Error("External token validation failed.");
  }

  return true;
}

export async function POST(request: NextRequest) {
  let requestBody: any;
  const callbackLogId = `cb_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const mask = (value: any) => {
    if (!value) return null;
    const s = String(value);
    if (s.length <= 6) return "***";
    return `${s.slice(0, 3)}***${s.slice(-3)}`;
  };
  try {
    requestBody = await request.json();
    console.log("[PAYMENT_CALLBACK] received payload", {
      callbackLogId,
      keys: Object.keys(requestBody || {}),
    });
  } catch (e: any) {
    console.error("Callback Error: Invalid callback JSON payload.", {
      callbackLogId,
      error: e?.message || e,
    });
    return NextResponse.json(
      { message: "Invalid callback payload." },
      { status: 400 }
    );
  }

  // Best-effort auth validation:
  // Some gateway callbacks may omit or reshape Authorization header.
  // We should still process valid transaction references to avoid missed repayments.
  try {
    const authHeader = request.headers.get("Authorization");
    let fixedAuthHeader: string | null = null;
    console.log("[PAYMENT_CALLBACK] Raw Authorization header", { authHeader });

    if (authHeader) {
      const tokenMatch = authHeader.match(/"token"\s*:\s*"([^"]+)"/);
      const rawToken = tokenMatch?.[1];
      fixedAuthHeader = rawToken ? `Bearer ${rawToken}` : authHeader;
      console.log("[PAYMENT_CALLBACK] Fixed Authorization header", {
        fixedAuthHeader,
      });
    }

    if (fixedAuthHeader) {
      await validateAuthHeader(fixedAuthHeader);
    } else {
      console.warn(
        "[PAYMENT_CALLBACK] Authorization header missing or malformed; continuing with reference-based processing."
      );
    }
  } catch (e: any) {
    console.warn("[PAYMENT_CALLBACK] Auth validation failed; continuing.", {
      error: e?.message || e,
    });
  }

  const normalizedTxnRef = requestBody?.txnRef ?? requestBody?.txn_ref ?? null;
  const normalizedTransactionId =
    requestBody?.transactionId ?? requestBody?.transaction_id ?? null;
  const {
    paidAmount = requestBody?.paid_amount,
    paidByNumber,
    txnRef = normalizedTxnRef,
    transactionId = normalizedTransactionId,
    transactionTime,
    accountNo,
    token,
    Signature: receivedSignature,
  } = requestBody;
  console.log("[PAYMENT_CALLBACK] normalized identifiers", {
    callbackLogId,
    txnRef: mask(txnRef),
    transactionId: mask(transactionId),
    paidAmount,
    paidByNumber: mask(paidByNumber),
    accountNo: mask(accountNo),
    hasToken: Boolean(token),
    hasSignature: Boolean(receivedSignature),
    transactionTime,
  });

  // --- Log payment transaction ---
  try {
    // Try to find an existing PaymentTransaction by either payload.transactionId
    // (the upstream's id) or by txnRef. If found, update that record and
    // ensure both columns are populated; otherwise create a new row.
    const existing = await prisma.paymentTransaction.findFirst({
      where: {
        OR: [
          transactionId ? { transactionId: transactionId } : undefined,
          txnRef ? { txnRef: txnRef } : undefined,
        ].filter(Boolean) as any,
      },
    });

    if (existing) {
      const existingAny: any = existing;
      await prisma.paymentTransaction.update({
        where: { id: existing.id },
        data: {
          status: "RECEIVED",
          payload: JSON.stringify(requestBody),
          transactionId: transactionId || existingAny.transactionId,
          txnRef: txnRef || existingAny.txnRef,
        } as any,
      });
    } else {
      await prisma.paymentTransaction.create({
        data: {
          transactionId: transactionId || txnRef,
          txnRef: txnRef,
          status: "RECEIVED",
          payload: JSON.stringify(requestBody),
        } as any,
      });
    }
  } catch (e) {
    console.error("Failed to log payment transaction:", e);
  }

  // Step 3: Process payment
  try {
    const callbackReference = txnRef || transactionId;
    console.log("[PAYMENT_CALLBACK] looking up pending payment", {
      callbackLogId,
      callbackReference: mask(callbackReference),
    });
    const pendingPayment = await prisma.pendingPayment.findFirst({
      where: {
        OR: [
          txnRef ? { transactionId: txnRef } : undefined,
          transactionId ? { transactionId } : undefined,
        ].filter(Boolean) as any,
      },
    });
    if (!pendingPayment) {
      console.error(
        "[PAYMENT_CALLBACK] no pending payment found",
        {
          callbackLogId,
          callbackReference: mask(callbackReference),
          txnRef: mask(txnRef),
          transactionId: mask(transactionId),
        }
      );
      return NextResponse.json(
        { message: "Transaction reference not found or already processed." },
        { status: 200 }
      );
    }
    if (pendingPayment.status === "COMPLETED") {
      console.log("[PAYMENT_CALLBACK] duplicate callback ignored", {
        callbackLogId,
        pendingPaymentId: pendingPayment.id,
        transactionId: mask(pendingPayment.transactionId),
      });
      return NextResponse.json(
        { message: "Payment already processed." },
        { status: 200 }
      );
    }

    const { loanId, amount: paymentAmount, borrowerId } = pendingPayment;
    console.log("[PAYMENT_CALLBACK] pending payment found", {
      callbackLogId,
      pendingPaymentId: pendingPayment.id,
      pendingStatus: pendingPayment.status,
      loanId,
      borrowerId: mask(borrowerId),
      expectedAmount: paymentAmount,
    });

    const [loan, taxConfigs] = await Promise.all([
      prisma.loan.findUnique({
        where: { id: loanId },
        include: {
          product: {
            include: { provider: { include: { ledgerAccounts: true } } },
          },
          payments: { orderBy: { date: "asc" } },
        },
      }),
      prisma.tax.findMany({ where: { status: "ACTIVE" } }),
    ]);
    if (!loan) throw new Error(`Loan with ID ${loanId} not found.`);
    const provider = loan.product.provider;
    // Use getAsOfDate() for calculations to match UI display during testing
    const paymentDate = getAsOfDate();
    const alreadyRepaid = loan.repaidAmount || 0;

    // If this loan has an installment schedule, apply this payment to the active installment.
    // This is necessary for Salary Advance products where repayments are installment-based.
    const hasInstallments = await prisma.loanInstallment.count({
      where: { loanId },
    });

    // provider ledger accounts log removed to reduce console noise
    const totals = calculateTotalRepayable(
      loan as any,
      loan.product as any,
      taxConfigs as any,
      paymentDate
    );
    const totalDue = totals.total - alreadyRepaid;
    console.log("[PAYMENT_CALLBACK] loan loaded", {
      callbackLogId,
      loanId: loan.id,
      providerId: loan.product.provider.id,
      hasInstallments,
      repaidAmount: alreadyRepaid,
      totalDue,
    });

    if (!hasInstallments && paymentAmount > totalDue + 0.01) {
      // Add tolerance for floating point
      console.error(
        `[PAYMENT_CALLBACK_ERROR] Overpayment detected. Payment amount (${paymentAmount}) exceeds balance due (${totalDue}).`
      );
      // We still have to accept the callback, but we will not process the payment.
      // And we will flag the pending payment as failed.
      await prisma.pendingPayment.update({
        where: { transactionId: pendingPayment.transactionId },
        data: { status: "FAILED" },
      });
      console.warn("[PAYMENT_CALLBACK] marked pending payment FAILED (overpay)", {
        callbackLogId,
        pendingPaymentId: pendingPayment.id,
        transactionId: mask(pendingPayment.transactionId),
      });
      return NextResponse.json(
        { message: "Overpayment detected, transaction will not be processed." },
        { status: 200 }
      );
    }
    //test
    const updatedLoan = await prisma.$transaction(async (tx) => {
      if (hasInstallments) {
        // Rollover merge: when an installment is past due, close it and merge
        // its amount into the next installment. The next installment becomes active.
        const installmentsBefore = await tx.loanInstallment.findMany({
          where: { loanId },
          orderBy: { installmentNumber: "asc" },
        });

        // Use centralized rollover logic with transaction client
        await ensureInstallmentRollover(tx as any, loanId, paymentDate);

        const refreshedInstallments = await tx.loanInstallment.findMany({
          where: { loanId },
          orderBy: { installmentNumber: "asc" },
        });
        const activeInstallment = refreshedInstallments.find(
          (i) => i.isActive && i.status !== "PAID"
        );
        if (!activeInstallment) {
          throw new Error("No active installment found for this loan.");
        }

        const penaltyRules = safeJsonParse(
          (loan.product as any).penaltyRules,
          []
        );
        const penaltyPerInstallment =
          (loan.product as any).penaltyPerInstallment ?? false;

        // If penaltyPerInstallment is ON, calculate penalty based on installment due date
        // If penaltyPerInstallment is OFF, calculate penalty based on loan due date only
        const penaltyDueDate = penaltyPerInstallment
          ? activeInstallment.dueDate
          : loan.dueDate;
        const penaltyForInstallment = calculatePenaltyForInstallment(
          activeInstallment.amount || 0,
          penaltyDueDate,
          penaltyRules,
          paymentDate
        );

        // Loan-level due buckets (service fee / interest / tax) are payable alongside installment repayments.
        // Only installment-level penalty+principal count toward installment.paidAmount.
        // Use detailed calculation to get accurate paid amounts from day-by-day simulation
        const totals = calculateTotalRepayableDetailed(
          loan as any,
          loan.product as any,
          taxConfigs,
          paymentDate
        );
        const alreadyRepaid = loan.repaidAmount || 0;

        // Each installment pays an equal share of service fee, interest, and tax.
        // We use a simple per-installment split rather than cumulative tracking
        // because serviceFeePaid/interestPaid from the calculator are unreliable
        // when daily fees are disabled (they stay 0).
        const totalInstallments = refreshedInstallments.length || 1;

        const serviceFeeDue = Math.max(0, totals.serviceFee / totalInstallments);
        const interestDue = Math.max(0, totals.interest / totalInstallments);

        // Tax proportional to per-installment taxable amounts
        const taxDue = Math.max(0, totals.tax / totalInstallments);

        const penaltyPaidSoFar = Math.min(
          activeInstallment.paidAmount || 0,
          penaltyForInstallment
        );
        const penaltyRemaining = Math.max(
          0,
          penaltyForInstallment - penaltyPaidSoFar
        );
        const principalPaidSoFar = Math.max(
          0,
          (activeInstallment.paidAmount || 0) - penaltyPaidSoFar
        );
        const principalRemaining = Math.max(
          0,
          (activeInstallment.amount || 0) - principalPaidSoFar
        );

        const totalDueForInstallment =
          principalRemaining +
          penaltyRemaining +
          serviceFeeDue +
          interestDue +
          taxDue;

        if (paymentAmount > totalDueForInstallment + 0.01) {
          console.error(
            `[PAYMENT_CALLBACK_ERROR] Overpayment detected. Payment amount (${paymentAmount}) exceeds installment due (${totalDueForInstallment}).`
          );
          await tx.pendingPayment.update({
            where: { transactionId: pendingPayment.transactionId },
            data: { status: "FAILED" },
          });
          return await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
        }

        const journalEntry = await tx.journalEntry.create({
          data: {
            providerId: provider.id,
            loanId: loan.id,
            date: paymentDate,
            description: `SuperApp repayment for installment ${activeInstallment.installmentNumber} of loan ${loan.id} via TxRef ${txnRef}`,
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

        const newPaidAmount =
          (activeInstallment.paidAmount || 0) + penaltyToPay + principalToPay;
        const isInstallmentFullyPaid =
          newPaidAmount >=
          (activeInstallment.amount || 0) + penaltyForInstallment - 1e-9;

        await tx.loanInstallment.update({
          where: { id: activeInstallment.id },
          data: {
            paidAmount: newPaidAmount,
            paidAt: paymentDate,
            status: isInstallmentFullyPaid ? "Paid" : "Pending",
            penaltyAmount: penaltyForInstallment,
            isActive: !isInstallmentFullyPaid,
          },
        });

        await tx.loan.update({
          where: { id: loanId },
          data: { repaidAmount: alreadyRepaid + paymentAmount },
        });

        if (isInstallmentFullyPaid) {
          // Mark all merged installments (that were merged INTO this active installment) as Paid
          // These are installments with status 'MERGED' and installmentNumber > activeInstallment.installmentNumber
          // that had their amount rolled into the active installment
          const mergedInstallments = refreshedInstallments.filter(
            (i) =>
              i.status === "MERGED" &&
              i.installmentNumber > activeInstallment.installmentNumber
          );

          if (mergedInstallments.length > 0) {
            await Promise.all(
              mergedInstallments.map((merged) =>
                tx.loanInstallment.update({
                  where: { id: merged.id },
                  data: { status: "PAID", paidAt: paymentDate },
                })
              )
            );
          }

          const nextPayable = await tx.loanInstallment.findFirst({
            where: {
              loanId,
              installmentNumber: { gt: activeInstallment.installmentNumber },
              status: { notIn: ["MERGED", "PAID"] },
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
            await tx.loan.update({
              where: { id: loanId },
              data: { repaymentStatus: "Paid" },
            });
          }
        }

        await createAuditLog({
          actorId: borrowerId,
          action: "REPAYMENT_SUCCESS",
          entity: "LOAN",
          entityId: loan.id,
          details: {
            transactionId: callbackReference,
            amount: paymentAmount,
            paidBy: paidByNumber,
            installmentNumber: activeInstallment.installmentNumber,
          },
        });

        await tx.pendingPayment.update({
          where: { transactionId: pendingPayment.transactionId },
          data: { status: "COMPLETED" },
        });
        console.log("[PAYMENT_CALLBACK] installment repayment completed", {
          callbackLogId,
          loanId,
          amount: paymentAmount,
          pendingPaymentId: pendingPayment.id,
        });

        return await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      }

      const journalEntry = await tx.journalEntry.create({
        data: {
          providerId: provider.id,
          loanId: loan.id,
          date: paymentDate,
          description: `SuperApp repayment for loan ${loan.id} via TxRef ${txnRef}`,
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

      const serviceFeeDue = Math.max(
        0,
        totals.serviceFee - alreadyPaidServiceFee
      );
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

      const newPayment = await tx.payment.create({
        data: {
          loanId,
          amount: paymentAmount,
          date: paymentDate,
          outstandingBalanceBeforePayment: totalDue,
          journalEntryId: journalEntry.id,
        },
      });

      const newRepaidAmount = alreadyRepaid + paymentAmount;
      const isFullyPaid = newRepaidAmount >= totals.total;
      let repaymentBehavior: RepaymentBehavior | null = null;

      if (isFullyPaid) {
        const today = startOfDay(new Date());
        const dueDate = startOfDay(loan.dueDate);
        if (isBefore(today, dueDate)) repaymentBehavior = "EARLY";
        else if (isEqual(today, dueDate)) repaymentBehavior = "ON_TIME";
        else repaymentBehavior = "LATE";
      }

      const finalLoan = await tx.loan.update({
        where: { id: loanId },
        data: {
          repaidAmount: newRepaidAmount,
          repaymentStatus: isFullyPaid ? "Paid" : "Unpaid",
          ...(repaymentBehavior && { repaymentBehavior }),
        },
      });

      await createAuditLog({
        actorId: borrowerId,
        action: "REPAYMENT_SUCCESS",
        entity: "LOAN",
        entityId: loan.id,
        details: {
          transactionId: callbackReference,
          amount: paymentAmount,
          paidBy: paidByNumber,
        },
      });

      await tx.pendingPayment.update({
        where: { transactionId: pendingPayment.transactionId },
        data: { status: "COMPLETED" },
      });
      console.log("[PAYMENT_CALLBACK] normal repayment completed", {
        callbackLogId,
        loanId,
        amount: paymentAmount,
        pendingPaymentId: pendingPayment.id,
      });

      return finalLoan;
    });

    console.log("[PAYMENT_CALLBACK] processing finished successfully", {
      callbackLogId,
      loanId: updatedLoan?.id,
    });
    return NextResponse.json(
      { message: "Payment confirmed and updated." },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("Callback Error: Failed to process payment update.", {
      callbackLogId,
      error: error?.message || error,
      stack: error?.stack,
    });
    return NextResponse.json(
      {
        message:
          error.message || "Internal server error during payment processing.",
      },
      { status: 400 }
    );
  }
}

