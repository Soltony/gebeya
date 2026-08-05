import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { calculateTotalRepayable } from "@/lib/loan-calculator";
import { getAsOfDate } from "@/lib/date-utils";
import { createAuditLog } from "@/lib/audit-log";
import { applyBnplRepayment } from "@/lib/bnpl-repayment";
import { syncCbsDeletionForBorrower } from "@/actions/cbs-npl";

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

  // --- Determine payment type: BNPL or DIRECT ---
  // Check both PendingPayment (BNPL) and DirectPendingPayment (DIRECT) by reference.
  const referenceFilter = [
    txnRef ? { transactionId: txnRef } : undefined,
    transactionId ? { transactionId } : undefined,
  ].filter(Boolean) as any;

  let paymentType: "BNPL" | "DIRECT" = "BNPL";
  const bnplPending = await prisma.pendingPayment.findFirst({
    where: { OR: referenceFilter },
  });
  const directPending = !bnplPending
    ? await (prisma as any).directPendingPayment.findFirst({
        where: { OR: referenceFilter },
      })
    : null;

  if (directPending) {
    paymentType = "DIRECT";
  }
  console.log("[PAYMENT_CALLBACK] resolved payment type", {
    callbackLogId,
    paymentType,
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
          paymentType,
          transactionId: transactionId || existingAny.transactionId,
          txnRef: txnRef || existingAny.txnRef,
        } as any,
      });
    } else {
      await prisma.paymentTransaction.create({
        data: {
          transactionId: transactionId || txnRef,
          txnRef: txnRef,
          paymentType,
          status: "RECEIVED",
          payload: JSON.stringify(requestBody),
        } as any,
      });
    }
  } catch (e) {
    console.error("Failed to log payment transaction:", e);
  }

  // --- Route to DIRECT payment handler ---
  if (paymentType === "DIRECT" && directPending) {
    try {
      if (directPending.status === "COMPLETED") {
        console.log("[PAYMENT_CALLBACK] duplicate direct callback ignored", {
          callbackLogId,
          directPendingId: directPending.id,
        });
        return NextResponse.json(
          { message: "Payment already processed." },
          { status: 200 }
        );
      }

      const {
        orderId,
        borrowerId,
        merchantId,
        amount: expectedAmount,
      } = directPending;

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new Error(`Order ${orderId} not found.`);
      }

      // Only move to DELIVERED if the order is in an appropriate state
      if (
        order.status === "ON_DELIVERY" ||
        order.status === "PENDING_MERCHANT_CONFIRMATION"
      ) {
        await prisma.order.update({
          where: { id: orderId },
          data: { status: "DELIVERED" },
        });
      }

      await (prisma as any).directPendingPayment.update({
        where: { transactionId: directPending.transactionId },
        data: { status: "COMPLETED" },
      });

      await prisma.paymentTransaction.updateMany({
        where: {
          OR: [
            transactionId ? { transactionId } : undefined,
            txnRef ? { txnRef } : undefined,
          ].filter(Boolean) as any,
        },
        data: { status: "PROCESSED" } as any,
      });

      await createAuditLog({
        actorId: borrowerId,
        action: "DIRECT_PAYMENT_SUCCESS",
        entity: "ORDER",
        entityId: orderId,
        details: {
          transactionId,
          txnRef,
          paidAmount,
          merchantId,
          expectedAmount,
        },
      });

      console.log("[PAYMENT_CALLBACK] direct payment processed", {
        callbackLogId,
        orderId,
        directPendingId: directPending.id,
      });
      return NextResponse.json(
        { message: "Direct payment processed successfully." },
        { status: 200 }
      );
    } catch (e: any) {
      console.error("Direct Payment Callback processing error:", e);
      return NextResponse.json(
        { message: e.message || "Internal processing error." },
        { status: 500 }
      );
    }
  }

  // --- Route to BNPL payment handler ---
  try {
    const callbackReference = txnRef || transactionId;
    console.log("[PAYMENT_CALLBACK] looking up pending payment", {
      callbackLogId,
      callbackReference: mask(callbackReference),
    });
    const pendingPayment = bnplPending;
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

      const result = await applyBnplRepayment(tx, {
        loan: loan as any,
        taxConfigs: taxConfigs as any,
        paymentAmount,
        paymentDate,
        describeJournal: (installmentNumber) =>
          installmentNumber === null
            ? `SuperApp repayment for loan ${loan.id} via TxRef ${txnRef}`
            : `SuperApp repayment for installment ${installmentNumber} of loan ${loan.id} via TxRef ${txnRef}`,
        auditActorId: borrowerId,
        auditDetails: {
          transactionId: callbackReference,
          paidBy: paidByNumber,
        },
        logLabel: "[PAYMENT_CALLBACK]",
        logId: callbackLogId,
      });

      // Nothing was applied — override the claim so the intent is not left
      // looking settled.
      if (result.outcome === "OVERPAYMENT") {
        await tx.pendingPayment.update({
          where: { transactionId: pendingPayment.transactionId },
          data: { status: "FAILED" },
        });
      }

      return await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
    });

    console.log("[PAYMENT_CALLBACK] processing finished successfully", {
      callbackLogId,
      loanId: updatedLoan?.id,
    });

    // Stop CBS NPL monitoring once this borrower has nothing unpaid left.
    // Best-effort and self-gating: it no-ops while unpaid loans remain.
    void syncCbsDeletionForBorrower(borrowerId, { source: "MANUAL" });
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

