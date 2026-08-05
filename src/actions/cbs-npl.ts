"use server";
/**
 * @fileOverview Digital Loan Repayment integration with the Core Banking
 * System (CBS) for Non-Performing Loans (NPL).
 *
 *  Workflow:
 *    1. uploadNplListToCbs() — pushes the current set of unpaid NPL account
 *       numbers to the CBS "bulk" endpoint for monitoring.
 *    2. processCreditNotification() — handles incoming credit notifications
 *       from the CBS, calls the CBS "repay" endpoint to debit the customer
 *       account, and posts the corresponding repayment in our ledgers.
 *    3. deleteNplAccountFromCbs() — stops CBS monitoring once a borrower
 *       leaves NPL, so the CBS is not left streaming credits we ignore.
 *
 * The internal posting goes through applyBnplRepayment(), the same pipeline the
 * payment-gateway callback and the manual pending-payment resolution use, so a
 * CBS auto-debit is indistinguishable from any other repayment in the ledgers.
 */
import prisma from "@/lib/prisma";
import { randomUUID } from "crypto";
import {
  deleteNplAccount,
  getDefaultCbsProviderId,
  requestRepay,
  uploadNplBulkInBatches,
} from "@/lib/cbs-npl/client";
import type {
  CbsCreditNotificationPayload,
  CbsRepayResponse,
} from "@/lib/cbs-npl/types";
import { calculateTotalRepayable } from "@/lib/loan-calculator";
import { applyBnplRepayment } from "@/lib/bnpl-repayment";
import { ensureInstallmentRollover } from "@/lib/installment-rollover";
import {
  computeActiveInstallmentDue,
  computeLoanLevelDue,
  MONEY_EPSILON,
} from "@/lib/repayment-due";
import { getAsOfDate } from "@/lib/date-utils";
import { createAuditLog } from "@/lib/audit-log";
import logger from "@/lib/logger";
import sendSms from "@/lib/sms";

const truncate = (value: string | undefined, max = 4000) => {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max)}…(truncated, len=${value.length})`;
};

const toJsonString = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------
// 1. Daily NPL bulk upload to the CBS
// ------------------------------------------------------------------

interface UploadResult {
  success: boolean;
  batchId: string;
  accountsSentCount: number;
  totalReceived?: number;
  insertedCount?: number;
  alreadyExistsCount?: number;
  message: string;
}

/**
 * Collect the active set of NPL account numbers (one per borrower w/ unpaid
 * NPL loans) and push them to the CBS bulk endpoint.
 */
export async function uploadNplListToCbs(opts?: {
  triggeredByUserId?: string;
  source?: "MANUAL" | "SCHEDULED";
}): Promise<UploadResult> {
  const source = opts?.source ?? (opts?.triggeredByUserId ? "MANUAL" : "SCHEDULED");

  const accountNumbers = await collectActiveNplAccountNumbers();

  const batch = await prisma.nplCbsUploadBatch.create({
    data: {
      triggeredByUserId: opts?.triggeredByUserId ?? null,
      source,
      status: "PENDING",
      accountsSentCount: accountNumbers.length,
      accountNumbers: JSON.stringify(accountNumbers),
    },
  });

  if (accountNumbers.length === 0) {
    const finished = await prisma.nplCbsUploadBatch.update({
      where: { id: batch.id },
      data: {
        status: "SUCCESS",
        totalReceived: 0,
        insertedCount: 0,
        alreadyExistsCount: 0,
        finishedAt: new Date(),
        responsePayload: JSON.stringify({ skipped: true, reason: "no NPL accounts" }),
      },
    });
    void logger.info(`[CBS-NPL] Upload skipped (no NPL accounts) batch=${batch.id}`);
    return {
      success: true,
      batchId: finished.id,
      accountsSentCount: 0,
      totalReceived: 0,
      insertedCount: 0,
      alreadyExistsCount: 0,
      message: "No NPL accounts to upload.",
    };
  }

  const result = await uploadNplBulkInBatches(accountNumbers);
  const finished = await prisma.nplCbsUploadBatch.update({
    where: { id: batch.id },
    data: {
      status: result.ok ? "SUCCESS" : "FAILED",
      httpStatus: result.status || null,
      totalReceived: result.data?.totalReceived ?? null,
      insertedCount: result.data?.insertedCount ?? null,
      alreadyExistsCount: result.data?.alreadyExistsCount ?? null,
      errorMessage:
        result.error ??
        (!result.ok ? truncate(result.rawResponse, 2000) ?? null : null),
      requestPayload: toJsonString(result.requestBody),
      responsePayload: result.rawResponse ?? null,
      finishedAt: new Date(),
    },
  });

  await createAuditLog({
    actorId: opts?.triggeredByUserId ?? "system",
    action: result.ok ? "CBS_NPL_BULK_UPLOAD_SUCCESS" : "CBS_NPL_BULK_UPLOAD_FAILED",
    entity: "NplCbsUploadBatch",
    entityId: finished.id,
    details: {
      accountsSentCount: accountNumbers.length,
      chunkCount: result.chunkCount,
      failedChunkIndexes: result.failedChunkIndexes,
      totalReceived: finished.totalReceived,
      insertedCount: finished.insertedCount,
      alreadyExistsCount: finished.alreadyExistsCount,
      httpStatus: finished.httpStatus,
      durationMs: result.durationMs,
      error: finished.errorMessage,
    },
  });

  const chunkNote =
    result.chunkCount > 1 ? ` in ${result.chunkCount} CBS request(s)` : "";

  return {
    success: result.ok,
    batchId: finished.id,
    accountsSentCount: accountNumbers.length,
    totalReceived: finished.totalReceived ?? undefined,
    insertedCount: finished.insertedCount ?? undefined,
    alreadyExistsCount: finished.alreadyExistsCount ?? undefined,
    message: result.ok
      ? `Uploaded ${accountNumbers.length} account(s) to CBS${chunkNote}.`
      : finished.errorMessage || "CBS upload failed.",
  };
}

/**
 * Pull the distinct list of bank account numbers for borrowers that are
 * currently flagged NPL and have at least one unpaid loan. Falls back to
 * provisionedData's account-number field if no PhoneAccount is registered.
 */
async function collectActiveNplAccountNumbers(): Promise<string[]> {
  const nplLoans = await prisma.loan.findMany({
    where: {
      repaymentStatus: "Unpaid",
      borrower: { status: "NPL" },
    },
    select: { borrowerId: true },
  });

  if (nplLoans.length === 0) return [];

  // Chunk id lists to stay under SQL Server's ~2100 query-parameter limit.
  const CHUNK_SIZE = 1000;
  const borrowerIds = Array.from(new Set(nplLoans.map((l) => l.borrowerId)));

  const accountByBorrower = new Map<string, string>();
  for (let i = 0; i < borrowerIds.length; i += CHUNK_SIZE) {
    const chunk = borrowerIds.slice(i, i + CHUNK_SIZE);
    const phoneAccounts = await prisma.phoneAccount.findMany({
      where: { phoneNumber: { in: chunk } },
      select: { phoneNumber: true, accountNumber: true, isActive: true },
    });
    for (const pa of phoneAccounts) {
      const existing = accountByBorrower.get(pa.phoneNumber);
      if (!existing || (pa.isActive && existing !== pa.accountNumber)) {
        accountByBorrower.set(pa.phoneNumber, pa.accountNumber);
      }
    }
  }

  // Fall back to the latest provisionedData payload for borrowers with no
  // registered PhoneAccount.
  const missingIds = borrowerIds.filter((id) => !accountByBorrower.has(id));
  for (let i = 0; i < missingIds.length; i += CHUNK_SIZE) {
    const chunk = missingIds.slice(i, i + CHUNK_SIZE);
    const pdRows = await prisma.provisionedData.findMany({
      where: { borrowerId: { in: chunk } },
      orderBy: { createdAt: "desc" },
      select: { borrowerId: true, data: true },
    });
    for (const row of pdRows) {
      if (accountByBorrower.has(row.borrowerId)) continue; // rows are newest-first
      const account = accountNumberFromProvisionedData(row.data);
      if (account) accountByBorrower.set(row.borrowerId, account);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const borrowerId of borrowerIds) {
    const account = accountByBorrower.get(borrowerId);
    if (account && !seen.has(account)) {
      seen.add(account);
      out.push(account);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// 1b. Removing accounts from CBS NPL monitoring
//
// Once a borrower exits NPL (their loan is fully repaid) we must tell the CBS
// to stop monitoring the account, otherwise the CBS keeps streaming credit
// notifications for accounts we no longer care about and its database fills up.
// ------------------------------------------------------------------

/** Pull a bank account number out of a provisionedData JSON blob. */
function accountNumberFromProvisionedData(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const pd = JSON.parse(raw);
    const candidate =
      pd.AccountNumber ??
      pd.accountNumber ??
      pd.account_number ??
      pd.accountNo ??
      pd.account_no ??
      null;
    return candidate ? String(candidate) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve every bank account number we may have uploaded for a borrower so we
 * can delete them from CBS monitoring. Mirrors the resolution used by the bulk
 * upload (registered PhoneAccount rows first, provisionedData as a fallback).
 */
async function resolveAccountNumbersForBorrower(borrowerId: string): Promise<string[]> {
  const accounts = new Set<string>();

  const phoneAccounts = await prisma.phoneAccount.findMany({
    where: { phoneNumber: borrowerId },
    select: { accountNumber: true },
  });
  for (const pa of phoneAccounts) {
    if (pa.accountNumber) accounts.add(String(pa.accountNumber));
  }

  if (accounts.size === 0) {
    const pd = await prisma.provisionedData.findFirst({
      where: { borrowerId },
      orderBy: { createdAt: "desc" },
      select: { data: true },
    });
    const fromPd = accountNumberFromProvisionedData(pd?.data);
    if (fromPd) accounts.add(fromPd);
  }

  return Array.from(accounts);
}

interface CbsDeletionResult {
  id: string;
  accountNumber: string;
  status: "SUCCESS" | "FAILED";
  httpStatus: number | null;
  message: string | null;
}

/**
 * Call the CBS delete endpoint for a single account and persist the outcome.
 * A 404 / "not found" response is treated as success: the goal is for the
 * account to be absent from CBS, and it already is.
 */
export async function deleteNplAccountFromCbs(args: {
  accountNumber: string;
  source: "AUTO" | "MANUAL";
  reason?: string;
  borrowerId?: string | null;
  triggeredByUserId?: string | null;
}): Promise<CbsDeletionResult> {
  const accountNumber = String(args.accountNumber).trim();
  const call = await deleteNplAccount(accountNumber);

  const notFound =
    call.status === 404 ||
    Boolean(call.data?.message?.toLowerCase().includes("not found"));
  const ok = call.ok || notFound;

  const record = await prisma.nplCbsDeletion.create({
    data: {
      accountNumber,
      source: args.source,
      status: ok ? "SUCCESS" : "FAILED",
      httpStatus: call.status || null,
      reason: args.reason ?? null,
      borrowerId: args.borrowerId ?? null,
      triggeredByUserId: args.triggeredByUserId ?? null,
      responsePayload: call.rawResponse ?? null,
      errorMessage: ok ? null : call.error ?? truncate(call.rawResponse, 2000) ?? null,
      finishedAt: new Date(),
    },
  });

  await createAuditLog({
    actorId: args.triggeredByUserId ?? (args.source === "AUTO" ? "cbs-auto" : "system"),
    action: ok ? "CBS_NPL_DELETE_SUCCESS" : "CBS_NPL_DELETE_FAILED",
    entity: "NplCbsDeletion",
    entityId: record.id,
    details: {
      accountNumber,
      source: args.source,
      httpStatus: call.status,
      borrowerId: args.borrowerId ?? null,
      message: call.data?.message ?? call.error ?? null,
    },
  });

  return {
    id: record.id,
    accountNumber,
    status: ok ? "SUCCESS" : "FAILED",
    httpStatus: call.status || null,
    message: call.data?.message ?? call.error ?? null,
  };
}

/**
 * Best-effort: when a borrower no longer has any unpaid loans, remove their
 * account(s) from CBS NPL monitoring. Safe to call after every repayment —
 * it no-ops while unpaid loans remain, and skips accounts already deleted
 * since the last upload. Never throws.
 */
export async function syncCbsDeletionForBorrower(
  borrowerId: string,
  opts?: { source?: "AUTO" | "MANUAL"; actorId?: string; reason?: string },
): Promise<void> {
  try {
    if (!borrowerId) return;

    const remainingUnpaid = await prisma.loan.count({
      where: { borrowerId, repaymentStatus: "Unpaid" },
    });
    if (remainingUnpaid > 0) return; // still has unpaid loans → keep monitored

    const accounts = await resolveAccountNumbersForBorrower(borrowerId);
    if (accounts.length === 0) return;

    const latestUpload = await prisma.nplCbsUploadBatch.aggregate({
      _max: { startedAt: true },
    });
    const latestUploadAt = latestUpload._max.startedAt;

    for (const accountNumber of accounts) {
      // Skip if we already deleted it and it hasn't been re-uploaded since.
      const priorSuccess = await prisma.nplCbsDeletion.findFirst({
        where: { accountNumber, status: "SUCCESS" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (
        priorSuccess &&
        (!latestUploadAt || priorSuccess.createdAt >= latestUploadAt)
      ) {
        continue;
      }

      await deleteNplAccountFromCbs({
        accountNumber,
        source: opts?.source ?? "AUTO",
        reason: opts?.reason ?? "Borrower exited NPL (loan fully repaid).",
        borrowerId,
        triggeredByUserId: opts?.actorId ?? null,
      });
    }
  } catch (e: any) {
    void logger.error(
      `[CBS-NPL] syncCbsDeletionForBorrower failed for borrower=${borrowerId}: ${String(e?.message ?? e)}`,
    );
  }
}

/**
 * Compute accounts that we previously pushed to the CBS but that are no longer
 * part of the active NPL set and have not yet been deleted — i.e. accounts that
 * exited NPL before the delete integration existed and are still cluttering the
 * CBS database. This powers the manual cleanup tab.
 */
export async function computeStaleCbsAccounts(): Promise<string[]> {
  const batches = await prisma.nplCbsUploadBatch.findMany({
    where: { status: "SUCCESS" },
    select: { accountNumbers: true },
  });

  const uploaded = new Set<string>();
  for (const b of batches) {
    try {
      const arr = JSON.parse(b.accountNumbers);
      if (Array.isArray(arr)) {
        for (const a of arr) if (a) uploaded.add(String(a));
      }
    } catch {
      // ignore malformed batch payloads
    }
  }
  if (uploaded.size === 0) return [];

  const [current, deletedRows] = await Promise.all([
    collectActiveNplAccountNumbers(),
    prisma.nplCbsDeletion.findMany({
      where: { status: "SUCCESS" },
      select: { accountNumber: true },
    }),
  ]);
  const currentSet = new Set(current);
  const deletedSet = new Set(deletedRows.map((d) => d.accountNumber));

  const stale: string[] = [];
  for (const account of uploaded) {
    if (!currentSet.has(account) && !deletedSet.has(account)) stale.push(account);
  }
  return stale.sort();
}

// ------------------------------------------------------------------
// 2. Inbound credit notification processing
// ------------------------------------------------------------------

interface ProcessResult {
  notificationId: string;
  status: string;
  message: string;
  repayResponse?: CbsRepayResponse | null;
}

const REPAY_TRIGGERING_STATUSES = new Set([
  "PENDING",
  "FAILED",
  "UNMATCHED_ACCOUNT",
  "NO_OUTSTANDING",
]);

/**
 * Persist an incoming credit notification (if new) and attempt an immediate
 * /repay against the CBS for the matched loan. Safe to retry.
 */
export async function processCreditNotification(
  payload: CbsCreditNotificationPayload,
  opts?: { actorId?: string; sourceIp?: string | null },
): Promise<ProcessResult> {
  const accountNumber = String(payload.accountNumber ?? "").trim();
  const creditedAmount = Number(payload.amount);
  const externalReference = payload.externalReference ? String(payload.externalReference) : null;
  console.log("[CBS-NPL][Process] Start", {
    accountNumber,
    creditedAmount,
    externalReference,
    correlationId: (payload as any)?.correlationId ?? null,
    providerId: payload.providerId ?? null,
    sourceIp: opts?.sourceIp ?? null,
  });

  if (!accountNumber || !Number.isFinite(creditedAmount) || creditedAmount < 0) {
    const created = await prisma.nplCreditNotification.create({
      data: {
        correlationId: randomUUID(),
        externalReference,
        accountNumber: accountNumber || "(missing)",
        creditedAmount: Number.isFinite(creditedAmount) ? creditedAmount : 0,
        providerId: payload.providerId ?? null,
        rawPayload: JSON.stringify(payload),
        processStatus: "FAILED",
        resultMessage: "Invalid payload: accountNumber and positive amount are required.",
        attempts: 1,
        lastAttemptAt: new Date(),
      },
    });
    return {
      notificationId: created.id,
      status: created.processStatus,
      message: created.resultMessage ?? "Invalid payload.",
    };
  }

  // Dedup by externalReference if present.
  if (externalReference) {
    const existing = await prisma.nplCreditNotification.findUnique({
      where: { externalReference },
    });
    if (existing) {
      console.log("[CBS-NPL][Process] Duplicate externalReference detected", {
        notificationId: existing.id,
        externalReference,
        existingStatus: existing.processStatus,
      });
      if (!REPAY_TRIGGERING_STATUSES.has(existing.processStatus)) {
        return {
          notificationId: existing.id,
          status: "DUPLICATE",
          message: `Notification already processed (status=${existing.processStatus}).`,
        };
      }
      // Otherwise retry the existing record below.
      return await attemptRepayForNotification(existing.id, opts?.actorId);
    }
  }

  const correlationId = randomUUID();
  const notification = await prisma.nplCreditNotification.create({
    data: {
      correlationId,
      externalReference,
      accountNumber,
      creditedAmount,
      providerId: payload.providerId ?? null,
      rawPayload: JSON.stringify(payload),
      processStatus: "PENDING",
    },
  });
  console.log("[CBS-NPL][Process] Notification persisted", {
    notificationId: notification.id,
    correlationId: notification.correlationId,
    accountNumber: notification.accountNumber,
    creditedAmount: notification.creditedAmount,
  });

  return await attemptRepayForNotification(notification.id, opts?.actorId);
}

/**
 * Re-run the /repay pipeline for a previously stored notification.
 * Used by the inbound webhook (new payload) and by the admin "Retry" action.
 */
export async function attemptRepayForNotification(
  notificationId: string,
  actorId?: string,
): Promise<ProcessResult> {
  console.log("[CBS-NPL][Repay] Attempt start", { notificationId, actorId: actorId ?? "cbs-webhook" });
  const notification = await prisma.nplCreditNotification.findUnique({
    where: { id: notificationId },
  });
  if (!notification) {
    return {
      notificationId,
      status: "FAILED",
      message: "Notification not found.",
    };
  }
  if (!REPAY_TRIGGERING_STATUSES.has(notification.processStatus)) {
    console.log("[CBS-NPL][Repay] Skipped terminal status", {
      notificationId: notification.id,
      status: notification.processStatus,
    });
    return {
      notificationId,
      status: notification.processStatus,
      message: `Notification in terminal status ${notification.processStatus}; nothing to do.`,
    };
  }

  // 1. Locate the loan to repay.
  const match = await locateLoanByAccountNumber(notification.accountNumber);
  if (!match) {
    console.log("[CBS-NPL][Repay] No matching unpaid loan found", {
      notificationId: notification.id,
      accountNumber: notification.accountNumber,
    });
    const updated = await prisma.nplCreditNotification.update({
      where: { id: notification.id },
      data: {
        processStatus: "UNMATCHED_ACCOUNT",
        resultMessage: "No unpaid NPL loan found for the supplied account number.",
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    await createAuditLog({
      actorId: actorId ?? "cbs-webhook",
      action: "CBS_CREDIT_NOTIFICATION_UNMATCHED",
      entity: "NplCreditNotification",
      entityId: updated.id,
      details: { accountNumber: notification.accountNumber },
    });
    return {
      notificationId: updated.id,
      status: updated.processStatus,
      message: updated.resultMessage ?? "Unmatched account.",
    };
  }

  const { loanId, borrowerId, collectableNow, totalOutstanding } = match;
  console.log("[CBS-NPL][Repay] Loan matched", {
    notificationId: notification.id,
    borrowerId,
    loanId,
    totalOutstanding,
    collectableNow,
    creditedAmount: notification.creditedAmount,
  });
  if (totalOutstanding <= MONEY_EPSILON) {
    const updated = await prisma.nplCreditNotification.update({
      where: { id: notification.id },
      data: {
        processStatus: "NO_OUTSTANDING",
        borrowerId,
        loanId,
        resultMessage: "Matched loan has no outstanding balance; nothing to collect.",
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    return {
      notificationId: updated.id,
      status: updated.processStatus,
      message: updated.resultMessage ?? "Loan is already fully paid.",
    };
  }

  // Determine how much can be collected based on the customer's available
  // balance (balance above the required minimum), NOT the credited amount.
  //   availableBalance = currentBalance - accountMinimumBalance
  //   amountToCollect  = min(collectableNow, availableBalance)
  let currentBalance = 0;
  let accountMinimumBalance = 0;
  try {
    const raw = JSON.parse(notification.rawPayload || "{}");
    currentBalance = Number(raw.currentBalance);
    accountMinimumBalance = Number(raw.accountMinimumBalance);
  } catch {
    // leave defaults; handled by the validity check below.
  }
  if (!Number.isFinite(currentBalance)) currentBalance = 0;
  if (!Number.isFinite(accountMinimumBalance)) accountMinimumBalance = 0;

  const availableBalance = Number((currentBalance - accountMinimumBalance).toFixed(2));

  // The CBS sometimes notifies us before the credit has settled on the
  // account, so `currentBalance` is a pre-credit snapshot and the available
  // balance reads far lower than what is really there — sometimes zero,
  // sometimes a small leftover. Whenever the reported available balance is
  // below the credited amount the snapshot cannot include the credit, so
  // collect against the credit instead. The CBS /repay call stays the
  // authority and will reject if the funds genuinely are not there yet.
  const creditedAmount = Number(notification.creditedAmount);
  const hasCredit = Number.isFinite(creditedAmount) && creditedAmount > MONEY_EPSILON;
  const usedCreditFallback = hasCredit && creditedAmount > availableBalance;
  const collectableBalance = usedCreditFallback
    ? Number(creditedAmount.toFixed(2))
    : availableBalance;

  const amountToCollect = Math.min(
    Number(collectableNow.toFixed(2)),
    collectableBalance,
  );

  console.log("[CBS-NPL][Repay] Balance-based collection", {
    notificationId: notification.id,
    totalOutstanding: Number(totalOutstanding.toFixed(2)),
    collectableNow: Number(collectableNow.toFixed(2)),
    currentBalance,
    accountMinimumBalance,
    availableBalance,
    creditedAmount,
    usedCreditFallback,
    collectableBalance,
    amountToCollect,
  });

  if (usedCreditFallback) {
    void logger.warn(
      `[CBS-NPL] Stale balance for notification=${notification.id} account=${notification.accountNumber} ` +
        `(currentBalance=${currentBalance}, minimum=${accountMinimumBalance}, available=${availableBalance} < credited=${collectableBalance}); ` +
        `collecting against the credited amount instead.`,
    );
  }

  // Nothing collectable: balance at/under the minimum. Keep retriable so a
  // future notification with more funds can collect later.
  if (amountToCollect <= MONEY_EPSILON) {
    const updated = await prisma.nplCreditNotification.update({
      where: { id: notification.id },
      data: {
        processStatus: "FAILED",
        borrowerId,
        loanId,
        resultMessage: `Insufficient available balance to collect (currentBalance=${currentBalance}, accountMinimumBalance=${accountMinimumBalance}, available=${availableBalance}, credited=${Number.isFinite(creditedAmount) ? creditedAmount : 0}).`,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    console.log("[CBS-NPL][Repay] Skipped — no available balance", {
      notificationId: notification.id,
      availableBalance,
    });
    return {
      notificationId: updated.id,
      status: updated.processStatus,
      message: updated.resultMessage ?? "Insufficient available balance.",
    };
  }

  console.log("[CBS-NPL][Repay] Calling CBS /repay", {
    notificationId: notification.id,
    correlationId: notification.correlationId,
    accountNumber: notification.accountNumber,
    amountToCollect,
  });

  // 2. Call CBS /repay.
  const cbsProviderId = notification.providerId?.trim() || getDefaultCbsProviderId();
  const repayCall = await requestRepay({
    correlationId: notification.correlationId,
    accountNumber: notification.accountNumber,
    amount: amountToCollect,
    providerId: cbsProviderId,
  });

  const repayData = repayCall.data;
  const repaySuccess =
    repayCall.ok && repayData?.status === "Success" && repayData?.status_code === 200;
  console.log("[CBS-NPL][Repay] CBS /repay response", {
    notificationId: notification.id,
    ok: repayCall.ok,
    httpStatus: repayCall.status,
    status: repayData?.status ?? null,
    statusCode: repayData?.status_code ?? null,
    transactionId: repayData?.transactionId ?? null,
    message: repayData?.message ?? repayCall.error ?? null,
  });

  // 3. If CBS confirmed the debit, record the repayment internally.
  let paymentId: string | null = null;
  let breakdown: CbsRepaymentBreakdown | null = null;
  let internalError: string | null = null;
  if (repaySuccess) {
    try {
      console.log("[CBS-NPL][AutoDebit] Internal posting start", {
        notificationId: notification.id,
        loanId,
        amount: amountToCollect,
      });
      breakdown = await recordCbsRepayment({
        loanId,
        amount: amountToCollect,
        correlationId: notification.correlationId,
        cbsTransactionId: repayData?.transactionId ?? null,
      });
      paymentId = breakdown.paymentId;
      console.log("[CBS-NPL][AutoDebit] Internal posting success", {
        notificationId: notification.id,
        paymentId,
      });
    } catch (e: any) {
      internalError = e?.message ?? String(e);
      console.error("[CBS-NPL][AutoDebit] Internal posting failed", {
        notificationId: notification.id,
        loanId,
        error: internalError,
      });
      void logger.error(
        `[CBS-NPL] Internal repayment posting failed for notification=${notification.id}: ${internalError}`,
      );
    }
  }

  // PARTIAL_REPAID only when money is genuinely still owed — a settled loan can
  // carry a few cents of rounding drift (see LOAN_SETTLE_EPSILON), and labelling
  // that "partial" would keep a closed loan looking open on the admin page.
  const finalStatus = repaySuccess
    ? internalError
      ? "FAILED"
      : breakdown && !breakdown.isFullyPaid && breakdown.remainingBalance > MONEY_EPSILON
        ? "PARTIAL_REPAID"
        : "REPAID"
    : repayData?.message?.toLowerCase().includes("duplicate")
      ? "DUPLICATE"
      : "FAILED";

  const updated = await prisma.nplCreditNotification.update({
    where: { id: notification.id },
    data: {
      borrowerId,
      loanId,
      paymentId: paymentId ?? null,
      processStatus: finalStatus,
      resultMessage: internalError
        ? `CBS debited but internal posting failed: ${internalError}`
        : repayData?.message ?? repayCall.error ?? null,
      repayHttpStatus: repayCall.status || null,
      repayTransactionId: repayData?.transactionId ?? null,
      repayDebitAmount: repayData?.debitAmount ?? amountToCollect,
      repayDebitAccount: repayData?.debitAccount ?? notification.accountNumber,
      repayCreditAccount: repayData?.creditAccount ?? null,
      repayResponse: repayCall.rawResponse ?? null,
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });
  console.log("[CBS-NPL][Repay] Notification updated", {
    notificationId: updated.id,
    finalStatus: updated.processStatus,
    paymentId: updated.paymentId ?? null,
    repayTransactionId: updated.repayTransactionId ?? null,
  });

  await createAuditLog({
    actorId: actorId ?? "cbs-webhook",
    action: repaySuccess
      ? internalError
        ? "CBS_REPAY_INTERNAL_POSTING_FAILED"
        : "CBS_REPAY_SUCCESS"
      : "CBS_REPAY_FAILED",
    entity: "NplCreditNotification",
    entityId: updated.id,
    details: {
      loanId,
      borrowerId,
      requestedAmount: amountToCollect,
      creditedAmount: notification.creditedAmount,
      cbsStatus: repayCall.status,
      cbsTransactionId: repayData?.transactionId,
      cbsMessage: repayData?.message,
      durationMs: repayCall.durationMs,
    },
  });

  // 4. Notify the borrower by SMS that a repayment was auto-debited, itemising
  // the principal, penalty and service fee collected. Best-effort: SMS failures
  // are logged but never roll back the (already committed) repayment.
  if (repaySuccess && !internalError && breakdown) {
    void notifyRepaymentBySms({
      phone: borrowerId,
      accountNumber: notification.accountNumber,
      breakdown,
      notificationId: notification.id,
    });
  }

  // When this repayment cleared the borrower's last unpaid loan, ask the CBS to
  // stop monitoring the account. Best-effort: never blocks or rolls back the
  // (already committed) repayment.
  if (repaySuccess && !internalError && breakdown?.isFullyPaid) {
    void syncCbsDeletionForBorrower(borrowerId, {
      source: "AUTO",
      reason: "NPL loan fully repaid via CBS auto-debit.",
    });
  }

  return {
    notificationId: updated.id,
    status: updated.processStatus,
    message:
      updated.resultMessage ??
      (repaySuccess ? "Repayment collected." : "Repayment failed."),
    repayResponse: repayData ?? null,
  };
}

// ------------------------------------------------------------------
// 2b. Automatic retry sweep for failed collections
// ------------------------------------------------------------------

const readIntEnv = (key: string, fallback: number) => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** Stop retrying a notification once it has been attempted this many times. */
const getRetryMaxAttempts = () => readIntEnv("NPL_RETRY_MAX_ATTEMPTS", 24);
/** Stop retrying once the credit is this old — the funds are long gone. */
const getRetryMaxAgeHours = () => readIntEnv("NPL_RETRY_MAX_AGE_HOURS", 48);
/** Cap the work done in a single sweep so one tick can never run away. */
const getRetryBatchSize = () => readIntEnv("NPL_RETRY_BATCH_SIZE", 50);

// The only failure the sweep retries: our own pre-flight check found no
// collectable balance, which resolves on its own once the CBS ledger catches up
// with the credit. Every other FAILED message is left alone — transport errors
// ("Request timed out after 20000ms", "3 failed") may have debited the
// customer without us seeing the response, and the rest fail identically on
// every attempt.
const INSUFFICIENT_BALANCE_MESSAGE_PREFIX = "Insufficient available balance to collect";

function isInsufficientBalanceFailure(resultMessage: string | null): boolean {
  return Boolean(resultMessage?.startsWith(INSUFFICIENT_BALANCE_MESSAGE_PREFIX));
}

export interface RetrySweepResult {
  scanned: number;
  eligible: number;
  retried: number;
  collected: number;
  stillFailing: number;
}

/**
 * Re-attempt the FAILED credit notifications that failed our insufficient
 * available balance check. Covers the CBS race where the balance snapshot had
 * not caught up with the credit at notification time, so the first attempt
 * found nothing to take. Intended to run on a short interval from the worker;
 * safe to run concurrently with inbound webhooks because each notification
 * carries a fixed correlationId that the CBS treats as an idempotency key.
 */
export async function retryFailedCreditNotificationsOnce(): Promise<RetrySweepResult> {
  const maxAttempts = getRetryMaxAttempts();
  const batchSize = getRetryBatchSize();
  const cutoff = new Date(Date.now() - getRetryMaxAgeHours() * 60 * 60 * 1000);

  // Scan wider than the batch because the message filter runs in JS: matching
  // in SQL would depend on the column's collation for case handling.
  const scanned = await prisma.nplCreditNotification.findMany({
    where: {
      processStatus: "FAILED",
      creditedAmount: { gt: MONEY_EPSILON },
      attempts: { lt: maxAttempts },
      receivedAt: { gte: cutoff },
    },
    orderBy: { receivedAt: "asc" },
    take: batchSize * 4,
    select: { id: true, accountNumber: true, resultMessage: true },
  });

  const candidates = scanned
    .filter((n) => isInsufficientBalanceFailure(n.resultMessage))
    .slice(0, batchSize);

  const result: RetrySweepResult = {
    scanned: scanned.length,
    eligible: candidates.length,
    retried: 0,
    collected: 0,
    stillFailing: 0,
  };
  if (candidates.length === 0) return result;

  console.log("[CBS-NPL][RetrySweep] Starting", {
    scanned: scanned.length,
    candidates: candidates.length,
  });

  for (const candidate of candidates) {
    try {
      const attempt = await attemptRepayForNotification(candidate.id, "cbs-npl-retry-service");
      result.retried += 1;
      if (attempt.status === "REPAID" || attempt.status === "PARTIAL_REPAID") {
        result.collected += 1;
      } else if (attempt.status === "FAILED") {
        result.stillFailing += 1;
      }
    } catch (error) {
      result.stillFailing += 1;
      console.error("[CBS-NPL][RetrySweep] Attempt threw", {
        notificationId: candidate.id,
        error: String(error),
      });
      void logger.error(
        `[CBS-NPL] Retry sweep failed for notification=${candidate.id}: ${String(error)}`,
      );
    }
  }

  console.log("[CBS-NPL][RetrySweep] Finished", result);
  return result;
}

/**
 * Send the borrower an SMS receipt for an auto-debited NPL repayment, breaking
 * the amount down into principal, penalty and service fee (interest and tax are
 * shown only when collected). Best-effort — never throws.
 */
async function notifyRepaymentBySms(args: {
  phone: string;
  accountNumber: string;
  breakdown: CbsRepaymentBreakdown;
  notificationId: string;
}): Promise<void> {
  const { phone, accountNumber, breakdown, notificationId } = args;
  const money = (n: number) =>
    Number(n || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  // Mask the account number so only the last 4 digits are shown, e.g. **0841.
  const maskAccount = (acct: string) => {
    const digits = String(acct ?? "").replace(/\s/g, "");
    return digits.length <= 4 ? digits : `**${digits.slice(-4)}`;
  };

  const lines = [
    `Dear customer, a loan repayment of Birr ${money(breakdown.paymentAmount)} was deducted from account ${maskAccount(accountNumber)}. for Nibtera Loan repayment.`,
    `Penalty: Birr ${money(breakdown.applied.penalty)}`,
    `Service Fee: Birr ${money(breakdown.applied.serviceFee)}`,
    `Principal: Birr ${money(breakdown.applied.principal)}`,
  ];
  if (breakdown.applied.interest > 0) {
    lines.push(`Interest: Birr ${money(breakdown.applied.interest)}`);
  }
  if (breakdown.applied.tax > 0) {
    lines.push(`Tax: Birr ${money(breakdown.applied.tax)}`);
  }
  lines.push(
    breakdown.isFullyPaid
      ? "Your loan is now fully paid. for further info call 9698"
      : `Outstanding balance: Birr ${money(breakdown.remainingBalance)}.for further info call 9698`,
  );

  try {
    const res = await sendSms(String(phone), lines.join("\n"));
    console.log("[CBS-NPL][AutoDebit] Repayment SMS", {
      notificationId,
      to: phone,
      ok: res.ok,
      error: res.ok ? undefined : res.error,
    });
    if (!res.ok) {
      void logger.warn(
        `[CBS-NPL] Repayment SMS to ${phone} failed for notification=${notificationId}: ${res.error ?? "unknown"}`,
      );
    }
  } catch (e: any) {
    const error = e?.message ?? String(e);
    console.error("[CBS-NPL][AutoDebit] Repayment SMS threw", {
      notificationId,
      to: phone,
      error,
    });
    void logger.error(
      `[CBS-NPL] Repayment SMS to ${phone} threw for notification=${notificationId}: ${error}`,
    );
  }
}

interface LoanMatch {
  loanId: string;
  borrowerId: string;
  /** Whole-loan balance still owed, used to report progress to the CBS log. */
  totalOutstanding: number;
  /**
   * The most we may debit in this attempt. For an installment loan that is the
   * ACTIVE installment's quote, not the whole loan: applyBnplRepayment refuses
   * anything above it, and refusing after the CBS has debited the customer
   * would take money we cannot post. Later installments are collected by the
   * next credit notification.
   */
  collectableNow: number;
}

/**
 * Find the unpaid loan to apply a CBS-credit repayment against.
 * Strategy: borrower with matching PhoneAccount.accountNumber, prefer the
 * most overdue Unpaid loan. Returns the loan id, what is collectable right
 * now, and the borrower id, or null when no match.
 */
async function locateLoanByAccountNumber(accountNumber: string): Promise<LoanMatch | null> {
  const phoneAccounts = await prisma.phoneAccount.findMany({
    where: { accountNumber },
    select: { phoneNumber: true, isActive: true },
  });
  if (phoneAccounts.length === 0) return null;

  // Prefer the active mapping when there are multiple rows for the same account.
  const ordered = [...phoneAccounts].sort((a, b) => Number(b.isActive) - Number(a.isActive));
  const borrowerIds = Array.from(new Set(ordered.map((p) => p.phoneNumber)));

  const asOfDate = getAsOfDate();
  const taxConfigs = await prisma.tax.findMany({ where: { status: "ACTIVE" } });

  const loans = await prisma.loan.findMany({
    where: {
      borrowerId: { in: borrowerIds },
      repaymentStatus: "Unpaid",
    },
    include: {
      product: true,
      payments: { orderBy: { date: "asc" } },
    },
    orderBy: { dueDate: "asc" },
  });

  for (const loan of loans) {
    const totalOutstanding = computeLoanLevelDue(
      loan as any,
      loan.product as any,
      taxConfigs as any,
      asOfDate,
    );
    if (totalOutstanding <= MONEY_EPSILON) continue;

    const installmentCount = await prisma.loanInstallment.count({ where: { loanId: loan.id } });
    if (installmentCount === 0) {
      return { loanId: loan.id, borrowerId: loan.borrowerId, totalOutstanding, collectableNow: totalOutstanding };
    }

    // Advance the schedule before quoting. applyBnplRepayment rolls overdue
    // installments forward as its first act, which moves/changes the active
    // installment; quoting beforehand would price the wrong one and the
    // posting would then be rejected as an overpayment.
    await ensureInstallmentRollover(prisma as any, loan.id, asOfDate);
    const installments = await prisma.loanInstallment.findMany({
      where: { loanId: loan.id },
      orderBy: { installmentNumber: "asc" },
    });

    const due = computeActiveInstallmentDue(
      loan as any,
      loan.product as any,
      taxConfigs as any,
      installments as any,
      asOfDate,
    );
    // No payable installment left but money still owed → the loan-level
    // residual branch of applyBnplRepayment collects it.
    const collectableNow = due ? due.total : totalOutstanding;
    if (collectableNow > MONEY_EPSILON) {
      return { loanId: loan.id, borrowerId: loan.borrowerId, totalOutstanding, collectableNow };
    }
  }

  return null;
}

/**
 * Post the CBS-collected repayment in our ledgers through applyBnplRepayment —
 * the same pipeline the payment-gateway callback uses — so installment
 * schedules, fee entitlement and the ledger accounts all move exactly as they
 * do for a borrower-initiated repayment.
 */
interface CbsRepaymentBreakdown {
  paymentId: string;
  paymentAmount: number;
  applied: {
    penalty: number;
    serviceFee: number;
    interest: number;
    tax: number;
    principal: number;
  };
  remainingBalance: number;
  isFullyPaid: boolean;
}

/**
 * Split a payment across the waterfall buckets in the order applyBnplRepayment
 * applies them (penalty → service fee → interest → tax → principal). Used for
 * the SMS receipt; applyBnplRepayment itself reports only the outcome.
 */
function splitAcrossBuckets(
  amount: number,
  buckets: { penalty: number; serviceFee: number; interest: number; tax: number; principal: number },
) {
  let remaining = amount;
  const take = (due: number) => {
    const paid = Math.max(0, Math.min(remaining, due));
    remaining -= paid;
    return paid;
  };
  return {
    penalty: take(buckets.penalty),
    serviceFee: take(buckets.serviceFee),
    interest: take(buckets.interest),
    tax: take(buckets.tax),
    principal: take(buckets.principal),
  };
}

async function recordCbsRepayment(args: {
  loanId: string;
  amount: number;
  correlationId: string;
  cbsTransactionId: string | null;
}): Promise<CbsRepaymentBreakdown> {
  const { loanId, amount, correlationId, cbsTransactionId } = args;
  console.log("[CBS-NPL][AutoDebit] Preparing ledger posting", {
    loanId,
    amount,
    correlationId,
    cbsTransactionId,
  });

  const [loan, taxConfigs] = await Promise.all([
    prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        product: { include: { provider: { include: { ledgerAccounts: true } } } },
        payments: { orderBy: { date: "asc" } },
      },
    }),
    prisma.tax.findMany({ where: { status: "ACTIVE" } }),
  ]);
  if (!loan) throw new Error(`Loan ${loanId} not found`);

  const paymentDate = getAsOfDate();
  const alreadyRepaid = loan.repaidAmount || 0;
  const totals = calculateTotalRepayable(
    loan as any,
    loan.product as any,
    taxConfigs as any,
    paymentDate,
  );

  // Quote the buckets the payment will land in, for the SMS receipt. The
  // schedule was already rolled forward by locateLoanByAccountNumber, so this
  // sees the same active installment applyBnplRepayment will.
  const installments = await prisma.loanInstallment.findMany({
    where: { loanId },
    orderBy: { installmentNumber: "asc" },
  });
  const due = installments.length
    ? computeActiveInstallmentDue(
        loan as any,
        loan.product as any,
        taxConfigs as any,
        installments as any,
        paymentDate,
      )
    : null;

  const buckets = due
    ? {
        penalty: due.penaltyRemaining,
        serviceFee: due.serviceFeeDue,
        interest: due.interestDue,
        tax: due.taxDue,
        principal: due.principalRemaining,
      }
    : loanLevelBuckets(totals, alreadyRepaid);

  const paymentAmount = Number(amount.toFixed(2));
  if (paymentAmount <= 0) {
    throw new Error("Nothing left to collect for this loan.");
  }
  const applied = splitAcrossBuckets(paymentAmount, buckets);

  const posted = await prisma.$transaction(async (tx) => {
    const result = await applyBnplRepayment(tx, {
      loan: loan as any,
      taxConfigs: taxConfigs as any,
      paymentAmount,
      paymentDate,
      describeJournal: (installmentNumber) =>
        installmentNumber === null
          ? `CBS NPL collection for loan ${loan.id} (correlationId=${correlationId}${cbsTransactionId ? ` cbsTxn=${cbsTransactionId}` : ""})`
          : `CBS NPL collection for installment ${installmentNumber} of loan ${loan.id} (correlationId=${correlationId}${cbsTransactionId ? ` cbsTxn=${cbsTransactionId}` : ""})`,
      auditActorId: loan.borrowerId,
      auditDetails: {
        source: "CBS_NPL_AUTO_DEBIT",
        correlationId,
        cbsTransactionId,
      },
      logLabel: "[CBS-NPL][AutoDebit]",
      logId: correlationId,
    });

    if (result.outcome === "OVERPAYMENT") {
      // The CBS has already debited the customer, so this must not commit —
      // throwing rolls the transaction back and marks the notification failed
      // for an operator to reverse or re-apply manually.
      throw new Error(
        `Collected ${paymentAmount} exceeds the ${result.scope} balance due (${result.due}); nothing was posted.`,
      );
    }

    // The journal description carries the correlationId, which makes the
    // freshly created payment identifiable without racing on timestamps.
    const payment = await tx.payment.findFirst({
      where: { loanId, journalEntry: { description: { contains: correlationId } } },
      orderBy: { date: "desc" },
      select: { id: true },
    });

    const updatedLoan = await tx.loan.findUniqueOrThrow({
      where: { id: loanId },
      select: { repaidAmount: true, repaymentStatus: true, borrowerId: true },
    });
    const isFullyPaid = updatedLoan.repaymentStatus === "Paid";

    // Clear the NPL flag once the borrower has no unpaid loans left.
    if (isFullyPaid) {
      const remaining = await tx.loan.count({
        where: { borrowerId: updatedLoan.borrowerId, repaymentStatus: "Unpaid" },
      });
      if (remaining === 0) {
        await tx.borrower.updateMany({
          where: { id: updatedLoan.borrowerId, status: "NPL" },
          data: { status: "Active" },
        });
      }
    }

    return {
      paymentId: payment?.id ?? "",
      repaidAmount: updatedLoan.repaidAmount || 0,
      isFullyPaid,
    };
  });

  const remainingBalance = Math.max(0, Number((totals.total - posted.repaidAmount).toFixed(2)));
  console.log("[CBS-NPL][AutoDebit] Ledger posting committed", {
    loanId,
    paymentId: posted.paymentId,
    paymentAmount,
    applied,
    remainingBalance,
    isFullyPaid: posted.isFullyPaid,
  });

  return {
    paymentId: posted.paymentId,
    paymentAmount,
    applied,
    remainingBalance,
    isFullyPaid: posted.isFullyPaid,
  };
}

/**
 * Loan-level bucket balances, mirroring how applyBnplRepayment attributes
 * everything received so far in waterfall order.
 */
function loanLevelBuckets(
  totals: { penalty: number; serviceFee: number; interest: number; tax: number; principal: number },
  alreadyRepaid: number,
) {
  const paidPenalty = Math.min(totals.penalty, alreadyRepaid);
  const paidServiceFee = Math.min(totals.serviceFee, Math.max(0, alreadyRepaid - totals.penalty));
  const paidInterest = Math.min(
    totals.interest,
    Math.max(0, alreadyRepaid - totals.penalty - totals.serviceFee),
  );
  const paidTax = Math.min(
    totals.tax,
    Math.max(0, alreadyRepaid - totals.penalty - totals.serviceFee - totals.interest),
  );
  const paidPrincipal = Math.min(
    totals.principal,
    Math.max(
      0,
      alreadyRepaid - totals.penalty - totals.serviceFee - totals.interest - totals.tax,
    ),
  );

  return {
    penalty: Math.max(0, totals.penalty - paidPenalty),
    serviceFee: Math.max(0, totals.serviceFee - paidServiceFee),
    interest: Math.max(0, totals.interest - paidInterest),
    tax: Math.max(0, totals.tax - paidTax),
    principal: Math.max(0, totals.principal - paidPrincipal),
  };
}
