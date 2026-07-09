import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { calculateTotalRepayable } from "@/lib/loan-calculator";
import { startOfDay, isBefore, isEqual, differenceInDays } from "date-fns";
import { getAsOfDate } from "@/lib/date-utils";
import { ensureInstallmentRollover } from "@/lib/installment-rollover";
import { createAuditLog } from "@/lib/audit-log";
import {
  computeActiveInstallmentDue,
  MONEY_EPSILON,
  LOAN_SETTLE_EPSILON,
} from "@/lib/repayment-due";
import { INSTALLMENT_STATUS, SETTLED_STATUSES } from "@/lib/installment-status";

// Local alias for repayment behavior values used in the code
type RepaymentBehavior = "EARLY" | "ON_TIME" | "LATE";

// A payment intent the gateway has not confirmed within this window is dead;
// refusing to process it prevents a late/replayed callback from applying a
// stale quote to today's balance.
const PENDING_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;

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

    if (Date.now() - new Date(pendingPayment.createdAt).getTime() > PENDING_PAYMENT_TTL_MS) {
      await prisma.pendingPayment.update({
        where: { transactionId: pendingPayment.transactionId },
        data: { status: "EXPIRED" },
      });
      console.warn("[PAYMENT_CALLBACK] stale payment intent expired", {
        callbackLogId,
        pendingPaymentId: pendingPayment.id,
        createdAt: pendingPayment.createdAt,
      });
      return NextResponse.json(
        { message: "Payment intent expired; not processed." },
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
    const updatedLoan = await prisma.$transaction(async (tx) => {
      // Claim this payment intent atomically. Under concurrent duplicate
      // callbacks both transactions reach this row; the second one blocks on
      // the row lock, then sees COMPLETED and applies nothing. If processing
      // below throws, the claim rolls back with the transaction.
      const claim = await tx.pendingPayment.updateMany({
        where: {
          transactionId: pendingPayment.transactionId,
          status: { notIn: ["COMPLETED", "EXPIRED"] },
        },
        data: { status: "COMPLETED" },
      });
      if (claim.count === 0) {
        console.log("[PAYMENT_CALLBACK] intent already claimed; skipping", {
          callbackLogId,
          pendingPaymentId: pendingPayment.id,
        });
        return await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
      }

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
          loan.product as any,
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
          if (paymentAmount > totalDue + MONEY_EPSILON) {
            console.error(
              `[PAYMENT_CALLBACK_ERROR] Overpayment detected. Payment amount (${paymentAmount}) exceeds loan-level balance due (${totalDue}).`
            );
            await tx.pendingPayment.update({
              where: { transactionId: pendingPayment.transactionId },
              data: { status: "FAILED" },
            });
            return await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
          }
          console.log(
            "[PAYMENT_CALLBACK] installments settled; collecting loan-level residual",
            { callbackLogId, loanId, totalDue }
          );
        }
      }

      if (due) {
        const activeInstallment = refreshedInstallments.find(
          (i) => i.id === due.installmentId
        )!;

        const alreadyRepaid = loan.repaidAmount || 0;
        const penaltyForInstallment = due.penaltyForInstallment;
        const penaltyRemaining = due.penaltyRemaining;
        const serviceFeeDue = due.serviceFeeDue;
        const interestDue = due.interestDue;
        const taxDue = due.taxDue;
        const principalRemaining = due.principalRemaining;
        const totalDueForInstallment = due.total;

        if (paymentAmount > totalDueForInstallment + MONEY_EPSILON) {
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
                "[PAYMENT_CALLBACK] all installments settled but loan under-collected; leaving Unpaid",
                {
                  callbackLogId,
                  loanId,
                  repaid: newRepaidTotal,
                  expected: totals.total,
                }
              );
            }
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
      const isFullyPaid = newRepaidAmount >= totals.total - LOAN_SETTLE_EPSILON;
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

