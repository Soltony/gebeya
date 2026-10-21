/**
 * Affiliate payouts.
 *
 * DRAFT (prepared by an admin or the scheduled job) → PENDING_APPROVAL
 * (submitted by a maker) → APPROVED (by a checker on the Approvals page) →
 * each payout is sent to CBS → SUCCESS or FAILED.
 *
 * A FAILED transfer is never retried automatically: if the request timed out
 * the bank may still have paid it, so an admin checks first and then either
 * retries it or releases its commissions back to the next batch.
 */
import { format, startOfMonth, startOfWeek, subMinutes } from 'date-fns';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { areDisbursementsEnabled } from '@/lib/disbursement-control';
import {
  auditExternalApiError,
  auditExternalApiRequest,
  auditExternalApiResponse,
  createAuditLog,
  newAuditCorrelationId,
} from '@/lib/audit-log';
import sendSms from '@/lib/sms';
import { formatMoney } from './config';
import { SELF_SERVICE } from './earn-rules';
import { roundMoney } from './engine';
import { postCommissionPayment } from './ledger';
import { chunk } from './db';
import { AffiliateError, getCurrentProgramVersion, type ProgramRuntime } from './programs';

/** A payout stuck in SENDING this long (e.g. the server restarted mid-call) can be handled by an admin. */
const STALE_SENDING_MINUTES = 10;
/** A timed-out request is marked FAILED with an "outcome unknown" warning, never retried automatically. */
const PAYOUT_TIMEOUT_MS = 60_000;

/** The account a borrower or new customer is paid into: the active one linked to their phone. */
export async function activeAccountForPhone(phone: string): Promise<string | null> {
  const account = await prisma.phoneAccount.findFirst({
    where: { phoneNumber: phone, isActive: true },
    select: { accountNumber: true },
  });
  return account?.accountNumber ?? null;
}

export type PrepareResult = {
  batchId: string | null;
  payoutCount: number;
  skippedNoAccount: number;
  skippedBelowMinimum: number;
  message: string;
};

/** Groups payable commissions per beneficiary into a DRAFT batch. */
export async function preparePayoutBatch(
  programId: string,
  options: { source: 'MANUAL' | 'SCHEDULED'; createdById?: string | null }
): Promise<PrepareResult> {
  const { program, config } = await getCurrentProgramVersion(programId);
  // Customers' own withdrawals waiting for review don't block admin batches.
  const open = await prisma.affiliatePayoutBatch.findFirst({
    where: { programId, status: { in: ['DRAFT', 'PENDING_APPROVAL'] }, source: { not: SELF_SERVICE } },
    select: { id: true },
  });
  if (open) {
    throw new AffiliateError('This program already has a payout batch waiting to be submitted or approved.', 409);
  }

  // Commissions of suspended affiliates (and the welcome bonuses of their
  // referrals) are held until the affiliate is reactivated.
  const commissions = await prisma.affiliateCommission.findMany({
    where: {
      status: 'PAYABLE',
      payoutId: null,
      affiliate: { status: 'ACTIVE' },
      referral: { programVersion: { programId } },
    },
    select: {
      id: true,
      beneficiary: true,
      beneficiaryPhone: true,
      amount: true,
      affiliate: { select: { id: true, type: true, payoutAccount: true, phoneNumber: true } },
    },
  });

  type Group = {
    beneficiary: string;
    phone: string;
    affiliate: (typeof commissions)[number]['affiliate'];
    ids: string[];
    gross: number;
  };
  const groups = new Map<string, Group>();
  for (const c of commissions) {
    const key = `${c.beneficiary}:${c.beneficiaryPhone}`;
    const group = groups.get(key) ?? { beneficiary: c.beneficiary, phone: c.beneficiaryPhone, affiliate: c.affiliate, ids: [], gross: 0 };
    group.ids.push(c.id);
    group.gross += c.amount;
    groups.set(key, group);
  }

  const minimum = Math.max(config.payout.minimumAmount, 0.01);
  const taxRate = config.payout.withholdingTaxPercent;
  const ready: Array<Group & { creditAccount: string; tax: number; net: number }> = [];
  let skippedNoAccount = 0;
  let skippedBelowMinimum = 0;

  for (const group of groups.values()) {
    const gross = roundMoney(group.gross);
    // Net of take-backs; below the minimum it carries over to the next batch.
    if (gross < minimum) {
      skippedBelowMinimum++;
      continue;
    }
    let creditAccount: string | null = null;
    if (group.beneficiary === 'AFFILIATE') {
      creditAccount = group.affiliate.payoutAccount
        ?? (group.affiliate.type === 'BORROWER' ? await activeAccountForPhone(group.affiliate.phoneNumber) : null);
    } else {
      creditAccount = await activeAccountForPhone(group.phone);
    }
    if (!creditAccount) {
      skippedNoAccount++;
      continue;
    }
    const tax = roundMoney((gross * taxRate) / 100);
    ready.push({ ...group, gross, creditAccount, tax, net: roundMoney(gross - tax) });
  }

  if (!ready.length) {
    return {
      batchId: null,
      payoutCount: 0,
      skippedNoAccount,
      skippedBelowMinimum,
      message: 'Nothing is ready to pay for this program right now.',
    };
  }

  const totals = ready.reduce(
    (acc, p) => ({ gross: acc.gross + p.gross, tax: acc.tax + p.tax, net: acc.net + p.net }),
    { gross: 0, tax: 0, net: 0 }
  );

  const batch = await prisma.$transaction(
    async (tx) => {
      const created = await tx.affiliatePayoutBatch.create({
        data: {
          programId,
          status: 'DRAFT',
          source: options.source,
          totalGross: roundMoney(totals.gross),
          totalTax: roundMoney(totals.tax),
          totalNet: roundMoney(totals.net),
          payoutCount: ready.length,
          createdById: options.createdById ?? null,
        },
      });
      for (const p of ready) {
        const payout = await tx.affiliatePayout.create({
          data: {
            batchId: created.id,
            beneficiary: p.beneficiary,
            affiliateId: p.beneficiary === 'AFFILIATE' ? p.affiliate.id : null,
            beneficiaryPhone: p.phone,
            creditAccount: p.creditAccount,
            grossAmount: p.gross,
            taxAmount: p.tax,
            netAmount: p.net,
            status: 'DRAFT',
          },
        });
        let claimed = 0;
        for (const ids of chunk(p.ids)) {
          const res = await tx.affiliateCommission.updateMany({
            where: { id: { in: ids }, status: 'PAYABLE', payoutId: null },
            data: { status: 'IN_PAYOUT', payoutId: payout.id },
          });
          claimed += res.count;
        }
        if (claimed !== p.ids.length) {
          throw new AffiliateError('Commissions changed while the batch was being prepared. Please try again.', 409);
        }
      }
      return created;
    },
    { timeout: 120_000, maxWait: 10_000 }
  );

  await createAuditLog({
    actorId: options.createdById ?? 'system',
    action: 'AFFILIATE_PAYOUT_BATCH_PREPARED',
    entity: 'AffiliatePayoutBatch',
    entityId: batch.id,
    details: { programId, source: options.source, payoutCount: ready.length, totalNet: batch.totalNet },
  });

  return {
    batchId: batch.id,
    payoutCount: ready.length,
    skippedNoAccount,
    skippedBelowMinimum,
    message: `Prepared ${ready.length} payout(s) for ${program.name}, ${formatMoney(batch.totalNet)} in total. Review it and submit it for approval.`,
  };
}

/** Prepares at most one scheduled draft per program per week/month. */
export async function prepareScheduledPayoutDrafts(now: Date, runtimes: Map<string, ProgramRuntime>): Promise<number> {
  let prepared = 0;
  for (const runtime of runtimes.values()) {
    const schedule = runtime.currentConfig?.payout.schedule;
    if (!schedule || schedule === 'MANUAL') continue;
    const periodStart = schedule === 'WEEKLY' ? startOfWeek(now, { weekStartsOn: 1 }) : startOfMonth(now);
    const last = await prisma.affiliatePayoutBatch.findFirst({
      where: { programId: runtime.id, source: 'SCHEDULED' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && last.createdAt >= periodStart) continue;
    try {
      const result = await preparePayoutBatch(runtime.id, { source: 'SCHEDULED', createdById: null });
      if (result.batchId) prepared++;
    } catch (error) {
      if (error instanceof AffiliateError && error.status === 409) continue;
      logger.error(`[affiliate] scheduled payout draft for program ${runtime.id} failed: ${String(error)}`);
    }
  }
  return prepared;
}

async function releaseCommissionsOfPayouts(tx: Prisma.TransactionClient, payoutIds: string[]) {
  for (const ids of chunk(payoutIds)) {
    await tx.affiliateCommission.updateMany({
      where: { payoutId: { in: ids }, status: 'IN_PAYOUT' },
      data: { status: 'PAYABLE', payoutId: null },
    });
  }
}

/** Maker step: sends a DRAFT batch to the Approvals queue. */
export async function submitPayoutBatch(batchId: string, user: { id: string }) {
  const batch = await prisma.affiliatePayoutBatch.findUnique({
    where: { id: batchId },
    include: { program: { select: { name: true } }, payouts: true },
  });
  if (!batch) throw new AffiliateError('Payout batch not found.', 404);
  if (batch.status !== 'DRAFT') throw new AffiliateError('Only a draft batch can be submitted.', 409);

  const name = `Payouts – ${batch.program.name} – ${format(batch.createdAt, 'yyyy-MM-dd')}`;
  const payload = {
    created: {
      name,
      programId: batch.programId,
      program: batch.program.name,
      payoutCount: batch.payoutCount,
      totalGross: batch.totalGross,
      totalTax: batch.totalTax,
      totalNet: batch.totalNet,
      payouts: batch.payouts.slice(0, 200).map((p) => ({
        beneficiary: p.beneficiary === 'AFFILIATE' ? 'Affiliate' : 'New customer',
        phone: p.beneficiaryPhone,
        account: p.creditAccount,
        gross: p.grossAmount,
        tax: p.taxAmount,
        net: p.netAmount,
      })),
    },
  };

  await prisma.$transaction(async (tx) => {
    const claim = await tx.affiliatePayoutBatch.updateMany({
      where: { id: batchId, status: 'DRAFT' },
      data: { status: 'PENDING_APPROVAL', submittedById: user.id, submittedAt: new Date() },
    });
    if (claim.count === 0) throw new AffiliateError('This batch was changed by someone else.', 409);
    const change = await tx.pendingChange.create({
      data: {
        entityType: 'AffiliatePayoutBatch',
        entityId: batchId,
        changeType: 'CREATE',
        payload: JSON.stringify(payload),
        status: 'PENDING',
        createdById: user.id,
      },
    });
    await tx.affiliatePayoutBatch.update({ where: { id: batchId }, data: { pendingChangeId: change.id } });
    await tx.affiliatePayout.updateMany({ where: { batchId, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } });
  });

  await createAuditLog({
    actorId: user.id,
    action: 'CHANGE_REQUEST_CREATED',
    entity: 'AffiliatePayoutBatch',
    entityId: batchId,
    details: { totalNet: batch.totalNet, payoutCount: batch.payoutCount },
  });
}

/** Discards a DRAFT batch; its commissions go back to PAYABLE. */
export async function cancelDraftBatch(batchId: string, user: { id: string }) {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.affiliatePayoutBatch.updateMany({
      where: { id: batchId, status: 'DRAFT' },
      data: { status: 'CANCELLED' },
    });
    if (claim.count === 0) throw new AffiliateError('Only a draft batch can be cancelled.', 409);
    const payouts = await tx.affiliatePayout.findMany({ where: { batchId }, select: { id: true } });
    await releaseCommissionsOfPayouts(tx, payouts.map((p) => p.id));
    await tx.affiliatePayout.updateMany({ where: { batchId }, data: { status: 'CANCELLED' } });
  });
  await createAuditLog({ actorId: user.id, action: 'AFFILIATE_PAYOUT_BATCH_CANCELLED', entity: 'AffiliatePayoutBatch', entityId: batchId });
}

/** Checker approved the batch (called from the Approvals flow). */
export async function approvePayoutBatch(batchId: string, actorId?: string) {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.affiliatePayoutBatch.updateMany({
      where: { id: batchId, status: 'PENDING_APPROVAL' },
      data: { status: 'APPROVED', approvedById: actorId ?? null, approvedAt: new Date() },
    });
    if (claim.count === 0) throw new AffiliateError('This payout batch is no longer waiting for approval.', 409);
    await tx.affiliatePayout.updateMany({ where: { batchId, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED' } });
  });
}

/** Checker rejected the batch: nothing is paid and the commissions return to PAYABLE. */
export async function rejectPayoutBatch(batchId: string) {
  await prisma.$transaction(async (tx) => {
    const claim = await tx.affiliatePayoutBatch.updateMany({
      where: { id: batchId, status: 'PENDING_APPROVAL' },
      data: { status: 'REJECTED' },
    });
    if (claim.count === 0) return;
    const payouts = await tx.affiliatePayout.findMany({ where: { batchId }, select: { id: true } });
    await releaseCommissionsOfPayouts(tx, payouts.map((p) => p.id));
    await tx.affiliatePayout.updateMany({ where: { batchId }, data: { status: 'CANCELLED' } });
  });
}

async function refreshBatchStatus(batchId: string) {
  const payouts = await prisma.affiliatePayout.findMany({ where: { batchId }, select: { status: true } });
  const statuses = payouts.map((p) => p.status);
  let status: string;
  if (statuses.some((s) => s === 'APPROVED' || s === 'SENDING')) status = 'APPROVED';
  else if (statuses.some((s) => s === 'FAILED')) status = 'PARTIAL';
  else if (statuses.some((s) => s === 'SUCCESS')) status = 'COMPLETED';
  else status = 'CANCELLED';
  await prisma.affiliatePayoutBatch.updateMany({
    where: { id: batchId, status: { in: ['APPROVED', 'PARTIAL', 'COMPLETED'] } },
    data: { status, completedAt: status === 'COMPLETED' ? new Date() : null },
  });
}

function payoutTarget() {
  const url = process.env.AFFILIATE_PAYOUT_URL || process.env.EXTERNAL_DISBURSEMENT_URL;
  const providerId = process.env.AFFILIATE_PAYOUT_PROVIDER_ID || process.env.FORCE_PROVIDER_ID || 'PRO0002';
  const user = process.env.EXTERNAL_API_USERNAME;
  const pass = process.env.EXTERNAL_API_PASSWORD;
  const auth = user && pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : undefined;
  return { url, providerId, auth };
}

async function markPayoutFailed(payoutId: string, message: string, extra: { statusCode?: number | null; responsePayload?: string | null } = {}) {
  await prisma.affiliatePayout.updateMany({
    where: { id: payoutId, status: 'SENDING' },
    data: { status: 'FAILED', errorMessage: message, statusCode: extra.statusCode ?? null, responsePayload: extra.responsePayload ?? null },
  });
}

export type SendOutcome = { status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; message: string };

/**
 * Sends one payout to CBS. `retry` re-sends a FAILED payout (or one stuck in
 * SENDING); only an admin action passes it.
 */
export async function sendPayout(payoutId: string, options: { retry?: boolean; actorId?: string } = {}): Promise<SendOutcome> {
  if (!(await areDisbursementsEnabled())) {
    return { status: 'SKIPPED', message: 'Disbursements are currently disabled.' };
  }
  const now = new Date();
  const claim = await prisma.affiliatePayout.updateMany({
    where: options.retry
      ? {
          id: payoutId,
          OR: [{ status: 'FAILED' }, { status: 'SENDING', lastAttemptAt: { lt: subMinutes(now, STALE_SENDING_MINUTES) } }],
        }
      : { id: payoutId, status: 'APPROVED' },
    data: { status: 'SENDING', attempts: { increment: 1 }, lastAttemptAt: now, errorMessage: null },
  });
  if (claim.count === 0) return { status: 'SKIPPED', message: 'This payout is not ready to be sent.' };

  const payout = await prisma.affiliatePayout.findUnique({ where: { id: payoutId } });
  if (!payout) return { status: 'SKIPPED', message: 'Payout not found.' };

  const { url, providerId, auth } = payoutTarget();
  const body = { creditAccount: payout.creditAccount, providerId, amount: payout.netAmount };
  const auditBase = {
    actorId: options.actorId ?? 'system',
    integration: 'AFFILIATE_PAYOUT',
    entity: 'AffiliatePayout',
    entityId: payout.id,
    correlationId: newAuditCorrelationId(),
  };

  if (!url) {
    await markPayoutFailed(payout.id, 'Missing EXTERNAL_DISBURSEMENT_URL (or AFFILIATE_PAYOUT_URL) env var');
    await refreshBatchStatus(payout.batchId);
    return { status: 'FAILED', message: 'Payout service URL is not configured.' };
  }

  await prisma.affiliatePayout.update({ where: { id: payout.id }, data: { requestPayload: JSON.stringify(body) } });
  await auditExternalApiRequest(auditBase, {
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body,
  }).catch(() => null);

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PAYOUT_TIMEOUT_MS),
    });
  } catch (error: any) {
    await auditExternalApiError(auditBase, error, { durationMs: Date.now() - startedAt }).catch(() => null);
    await markPayoutFailed(
      payout.id,
      `Request failed: ${String(error?.message ?? error)}. The bank may still have processed it; check before retrying.`
    );
    await refreshBatchStatus(payout.batchId);
    return { status: 'FAILED', message: 'Could not reach the payout service.' };
  }

  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  await auditExternalApiResponse(auditBase, {
    status: res.status,
    statusText: res.statusText,
    body: parsed,
    durationMs: Date.now() - startedAt,
  }).catch(() => null);

  if (!res.ok) {
    await markPayoutFailed(payout.id, `Payout service returned status ${res.status}.`, { statusCode: res.status, responsePayload: text || null });
    await refreshBatchStatus(payout.batchId);
    return { status: 'FAILED', message: `Payout service returned status ${res.status}.` };
  }

  const transactionId =
    parsed && typeof parsed === 'object'
      ? parsed.transactionId ?? parsed.transactionid ?? parsed.transaction_id ?? null
      : null;

  await prisma.$transaction(async (tx) => {
    const done = await tx.affiliatePayout.updateMany({
      where: { id: payout.id, status: 'SENDING' },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(),
        transactionId: transactionId ? String(transactionId) : null,
        statusCode: res.status,
        responsePayload: text || null,
      },
    });
    if (done.count === 0) return;
    await tx.affiliateCommission.updateMany({ where: { payoutId: payout.id, status: 'IN_PAYOUT' }, data: { status: 'PAID' } });

    // Settle Commission Payable on each provider ledger the payout drew from.
    const booked = await tx.affiliateCommission.groupBy({
      by: ['providerId'],
      where: { payoutId: payout.id, ledgerPosted: true, providerId: { not: null } },
      _sum: { amount: true },
    });
    for (const row of booked) {
      if (!row.providerId) continue;
      await postCommissionPayment(tx, {
        providerId: row.providerId,
        amount: row._sum.amount ?? 0,
        date: new Date(),
        description: `Affiliate commission paid to ${payout.beneficiaryPhone} (payout ${payout.id})`,
      });
    }
  });

  await refreshBatchStatus(payout.batchId);
  await createAuditLog({
    actorId: options.actorId ?? 'system',
    action: 'AFFILIATE_PAYOUT_SENT',
    entity: 'AffiliatePayout',
    entityId: payout.id,
    details: { amount: payout.netAmount, creditAccount: payout.creditAccount, transactionId },
  });
  // Opt-in, because SMS_URL is the bank's real gateway even on dev machines.
  if (process.env.AFFILIATE_PAYOUT_SMS === 'true') {
    void sendSms(
      payout.beneficiaryPhone,
      `Your referral earnings of ${formatMoney(payout.netAmount)} were paid to your account ending ${payout.creditAccount.slice(-4)}.`,
      { affiliatePayoutId: payout.id }
    );
  }
  return { status: 'SUCCESS', message: 'Paid.' };
}

/** Sends every APPROVED payout (of one batch, or all). Never retries failures. */
export async function sendApprovedPayouts(batchId?: string) {
  const payouts = await prisma.affiliatePayout.findMany({
    where: { status: 'APPROVED', ...(batchId ? { batchId } : {}) },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const summary = { sent: 0, failed: 0, skipped: 0 };
  for (const p of payouts) {
    try {
      const outcome = await sendPayout(p.id);
      if (outcome.status === 'SUCCESS') summary.sent++;
      else if (outcome.status === 'FAILED') summary.failed++;
      else summary.skipped++;
      // Disbursements switched off: stop and leave the rest APPROVED for later.
      if (outcome.status === 'SKIPPED' && outcome.message.startsWith('Disbursements')) break;
    } catch (error) {
      summary.failed++;
      logger.error(`[affiliate] payout ${p.id} failed: ${String(error)}`);
    }
  }
  if (payouts.length) {
    logger.info(`[affiliate] payouts sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}`);
  }
  return summary;
}

/** Gives up on a FAILED (or stuck) payout: its commissions go to the next batch. */
export async function releasePayout(payoutId: string, user: { id: string }) {
  const now = new Date();
  const payout = await prisma.$transaction(async (tx) => {
    const claim = await tx.affiliatePayout.updateMany({
      where: {
        id: payoutId,
        OR: [{ status: 'FAILED' }, { status: 'SENDING', lastAttemptAt: { lt: subMinutes(now, STALE_SENDING_MINUTES) } }],
      },
      data: { status: 'CANCELLED' },
    });
    if (claim.count === 0) throw new AffiliateError('Only a failed payout can be released.', 409);
    await releaseCommissionsOfPayouts(tx, [payoutId]);
    return tx.affiliatePayout.findUnique({ where: { id: payoutId }, select: { batchId: true } });
  });
  if (payout) await refreshBatchStatus(payout.batchId);
  await createAuditLog({ actorId: user.id, action: 'AFFILIATE_PAYOUT_RELEASED', entity: 'AffiliatePayout', entityId: payoutId });
}
