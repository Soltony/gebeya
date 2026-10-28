/**
 * Self-service withdrawals from the mini-app's Earn page.
 *
 * A person withdraws their available earnings, within the program's daily and
 * monthly limits, always to their own account: the account linked to their
 * phone, or the payout account the bank registered for an agent. They never
 * type an account number.
 *
 * Each withdrawal is a one-payout batch (source SELF_SERVICE) per program, so it
 * shares the sending, ledger and failure handling of admin batches. Up to the
 * program's automatic limit it is approved and sent at once. Larger ones wait
 * in Affiliates → Payouts for a reviewer with Update on Approvals: the customer
 * is the maker, so a staff member checks it, and never their own.
 */
import { startOfDay, startOfMonth } from 'date-fns';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { createAuditLog } from '@/lib/audit-log';
import { getPhoneNumbersForAccount } from '@/lib/account-utils';
import type { ProgramConfig } from './config';
import { roundMoney } from './engine';
import { SELF_SERVICE, selectForWithdrawal, withdrawalBlockedReason, withdrawalCap } from './earn-rules';
import { chunk } from './db';
import { findAffiliateForPhones, ownCommissions, ownPayouts } from './people';
import { AffiliateError, loadProgramRuntimes } from './programs';
import { activeAccountForPhone, approvePayoutBatch, rejectPayoutBatch, sendApprovedPayouts } from './payouts';
import { normalizePhone } from './schemas';

export type WithdrawalOffer = {
  /** What one withdrawal would send now; zero when nothing can be withdrawn. */
  gross: number;
  tax: number;
  net: number;
  /** Where the money goes, masked; null until there is something to send. */
  account: string | null;
  /** Part of it waits for a reviewer before it is sent. */
  needsReview: boolean;
  /** Why nothing can be withdrawn right now, in customer words; null when it can. */
  reason: string | null;
};

type WithdrawSettings = ProgramConfig['withdraw'] & { taxPercent: number };

type Group = {
  programId: string;
  beneficiary: string;
  phone: string;
  affiliateId: string | null;
  creditAccount: string;
  commissionIds: string[];
  gross: number;
  tax: number;
  net: number;
  sendAtOnce: boolean;
};

type Plan = { offer: WithdrawalOffer; groups: Group[] };

// A failed transfer counts as in progress: an admin checks it with the bank
// before retrying it or releasing the money.
const IN_PROGRESS = ['PENDING_APPROVAL', 'APPROVED', 'SENDING', 'FAILED'];

const maskAccount = (account: string) => `••••${account.slice(-4)}`;

/**
 * Works out what one withdrawal would pay. Null when no program the person
 * earns in allows withdrawals; the Earn page then shows no Withdraw button.
 */
async function planWithdrawal(borrowerId: string, now = new Date()): Promise<Plan | null> {
  const phones = await getPhoneNumbersForAccount(borrowerId);
  const affiliate = await findAffiliateForPhones(phones);
  const [runtimes, payable] = await Promise.all([
    loadProgramRuntimes(),
    prisma.affiliateCommission.findMany({
      where: { ...ownCommissions(affiliate?.id ?? null, phones), status: 'PAYABLE', payoutId: null },
      select: {
        id: true,
        amount: true,
        eventDate: true,
        beneficiary: true,
        beneficiaryPhone: true,
        affiliate: { select: { id: true, type: true, status: true, payoutAccount: true, phoneNumber: true } },
        referral: { select: { programVersion: { select: { programId: true } } } },
      },
    }),
  ]);

  const programIds = new Set(payable.map((c) => c.referral.programVersion.programId));
  if (affiliate) programIds.add(affiliate.programId);
  const allowing = new Map<string, WithdrawSettings>();
  for (const id of programIds) {
    const config = runtimes.get(id)?.currentConfig;
    if (config?.withdraw.enabled) allowing.set(id, { ...config.withdraw, taxPercent: config.payout.withholdingTaxPercent });
  }
  if (!allowing.size) return null;

  const nothing = (reason: string): Plan => ({
    offer: { gross: 0, tax: 0, net: 0, account: null, needsReview: false, reason },
    groups: [],
  });

  if (affiliate && affiliate.status !== 'ACTIVE') return nothing('Your earnings are on hold while the bank reviews your account.');

  const payoutsWhere = ownPayouts(affiliate?.id ?? null, phones);
  const [inProgress, recent] = await Promise.all([
    prisma.affiliatePayout.count({
      where: { ...payoutsWhere, status: { in: IN_PROGRESS }, batch: { source: SELF_SERVICE } },
    }),
    prisma.affiliatePayout.findMany({
      where: { ...payoutsWhere, status: { not: 'CANCELLED' }, batch: { source: SELF_SERVICE }, createdAt: { gte: startOfMonth(now) } },
      select: { grossAmount: true, createdAt: true, batch: { select: { programId: true } } },
    }),
  ]);
  if (inProgress) return nothing('Your last withdrawal is still being processed.');

  // Welcome bonuses whose affiliate is suspended wait, as in admin payouts.
  const usable = payable.filter((c) => c.affiliate.status === 'ACTIVE' && allowing.has(c.referral.programVersion.programId));
  const total = roundMoney(usable.reduce((sum, c) => sum + c.amount, 0));
  if (total <= 0) {
    return nothing(total < 0 ? 'A take-back is being recovered from your next earnings.' : 'You have no earnings to withdraw yet.');
  }

  const dayStart = startOfDay(now);
  const groups: Group[] = [];
  let reason: string | null = null;
  for (const [programId, settings] of allowing) {
    const rows = usable.filter((c) => c.referral.programVersion.programId === programId);
    if (!rows.length) continue;
    const withdrawn = recent.filter((p) => p.batch.programId === programId);
    const used = {
      today: withdrawn.filter((p) => p.createdAt >= dayStart).reduce((sum, p) => sum + p.grossAmount, 0),
      month: withdrawn.reduce((sum, p) => sum + p.grossAmount, 0),
    };
    let room = withdrawalCap(settings, used);

    // One transfer per beneficiary role, as in admin payouts.
    const byRole = new Map<string, typeof rows>();
    for (const c of rows) {
      const key = `${c.beneficiary}:${c.beneficiaryPhone}`;
      byRole.set(key, [...(byRole.get(key) ?? []), c]);
    }
    for (const roleRows of byRole.values()) {
      const picked = selectForWithdrawal(roleRows, room);
      if (picked.total <= 0 || picked.total < settings.minimum) {
        reason ??= withdrawalBlockedReason(settings, used, roleRows);
        continue;
      }
      const first = roleRows[0];
      const creditAccount =
        first.beneficiary === 'AFFILIATE'
          ? first.affiliate.payoutAccount ??
            (first.affiliate.type === 'BORROWER' ? await activeAccountForPhone(first.affiliate.phoneNumber) : null)
          : await activeAccountForPhone(first.beneficiaryPhone);
      if (!creditAccount) {
        reason ??= "We couldn't find an account linked to your phone. Please contact the bank.";
        continue;
      }
      const tax = roundMoney((picked.total * settings.taxPercent) / 100);
      const net = roundMoney(picked.total - tax);
      groups.push({
        programId,
        beneficiary: first.beneficiary,
        phone: first.beneficiaryPhone,
        affiliateId: first.beneficiary === 'AFFILIATE' ? first.affiliate.id : null,
        creditAccount,
        commissionIds: picked.rows.map((r) => r.id),
        gross: picked.total,
        tax,
        net,
        sendAtOnce: net <= settings.autoApproveUpTo,
      });
      if (room != null) room = roundMoney(room - picked.total);
    }
  }

  if (!groups.length) return nothing(reason ?? 'You have no earnings to withdraw yet.');
  const sum = (pick: (g: Group) => number) => roundMoney(groups.reduce((acc, g) => acc + pick(g), 0));
  const accounts = new Set(groups.map((g) => g.creditAccount));
  return {
    offer: {
      gross: sum((g) => g.gross),
      tax: sum((g) => g.tax),
      net: sum((g) => g.net),
      account: accounts.size === 1 ? maskAccount(groups[0].creditAccount) : 'your accounts',
      needsReview: groups.some((g) => !g.sendAtOnce),
      reason: null,
    },
    groups,
  };
}

/** What the Earn page shows next to the balance; null when withdrawals aren't offered. */
export async function getWithdrawalOffer(borrowerId: string): Promise<WithdrawalOffer | null> {
  return (await planWithdrawal(borrowerId))?.offer ?? null;
}

/** Withdraws everything the person may withdraw now. */
export async function requestWithdrawal(borrowerId: string): Promise<{ net: number; account: string | null; inReview: boolean }> {
  const plan = await planWithdrawal(borrowerId);
  if (!plan) throw new AffiliateError('Withdrawals are not available.', 403);
  if (plan.offer.reason || !plan.groups.length) {
    throw new AffiliateError(plan.offer.reason ?? 'You have no earnings to withdraw yet.', 409);
  }

  const now = new Date();
  const created = await prisma.$transaction(
    async (tx) => {
      const batches: Array<{ id: string; group: Group }> = [];
      for (const group of plan.groups) {
        const status = group.sendAtOnce ? 'APPROVED' : 'PENDING_APPROVAL';
        const batch = await tx.affiliatePayoutBatch.create({
          data: {
            programId: group.programId,
            status,
            source: SELF_SERVICE,
            totalGross: group.gross,
            totalTax: group.tax,
            totalNet: group.net,
            payoutCount: 1,
            submittedAt: now,
            approvedAt: group.sendAtOnce ? now : null,
          },
        });
        const payout = await tx.affiliatePayout.create({
          data: {
            batchId: batch.id,
            beneficiary: group.beneficiary,
            affiliateId: group.affiliateId,
            beneficiaryPhone: group.phone,
            creditAccount: group.creditAccount,
            grossAmount: group.gross,
            taxAmount: group.tax,
            netAmount: group.net,
            status,
          },
        });
        // Claiming is the guard against paying twice: a second tap finds the
        // commissions already taken and rolls back.
        let claimed = 0;
        for (const ids of chunk(group.commissionIds)) {
          const res = await tx.affiliateCommission.updateMany({
            where: { id: { in: ids }, status: 'PAYABLE', payoutId: null },
            data: { status: 'IN_PAYOUT', payoutId: payout.id },
          });
          claimed += res.count;
        }
        if (claimed !== group.commissionIds.length) {
          throw new AffiliateError('Your earnings changed while we were preparing the withdrawal. Please try again.', 409);
        }
        batches.push({ id: batch.id, group });
      }
      return batches;
    },
    { timeout: 60_000, maxWait: 10_000 }
  );

  for (const { id, group } of created) {
    await createAuditLog({
      actorId: borrowerId,
      action: 'AFFILIATE_WITHDRAWAL_REQUESTED',
      entity: 'AffiliatePayoutBatch',
      entityId: id,
      details: {
        programId: group.programId,
        gross: group.gross,
        tax: group.tax,
        net: group.net,
        creditAccount: group.creditAccount,
        sentAtOnce: group.sendAtOnce,
      },
    });
    if (group.sendAtOnce) {
      // Sent after the response, like approved admin batches; anything left
      // APPROVED (e.g. disbursements switched off) is sent by the worker.
      void sendApprovedPayouts(id).catch((error) =>
        logger.error(`[affiliate] sending withdrawal ${id} failed: ${String(error)}`)
      );
    }
  }
  return { net: plan.offer.net, account: plan.offer.account, inReview: plan.offer.needsReview };
}

type Reviewer = { id: string; phoneNumber?: string | null };

async function loadWithdrawalForReview(batchId: string, reviewer: Reviewer) {
  const batch = await prisma.affiliatePayoutBatch.findUnique({
    where: { id: batchId },
    select: { id: true, source: true, status: true, totalNet: true, payouts: { select: { beneficiaryPhone: true } } },
  });
  if (!batch || batch.source !== SELF_SERVICE) throw new AffiliateError('Withdrawal not found.', 404);
  if (batch.status !== 'PENDING_APPROVAL') throw new AffiliateError('This withdrawal is no longer waiting for review.', 409);

  // Maker-checker: staff can be affiliates too, and never review their own money.
  const reviewerPhone = reviewer.phoneNumber ? normalizePhone(reviewer.phoneNumber) : null;
  if (reviewerPhone) {
    for (const payout of batch.payouts) {
      const theirs = await getPhoneNumbersForAccount(payout.beneficiaryPhone);
      if (theirs.some((phone) => normalizePhone(phone) === reviewerPhone)) {
        throw new AffiliateError("You can't review your own withdrawal.", 403);
      }
    }
  }
  return batch;
}

export async function approveWithdrawal(batchId: string, reviewer: Reviewer) {
  const batch = await loadWithdrawalForReview(batchId, reviewer);
  await approvePayoutBatch(batchId, reviewer.id);
  await createAuditLog({
    actorId: reviewer.id,
    action: 'AFFILIATE_WITHDRAWAL_APPROVED',
    entity: 'AffiliatePayoutBatch',
    entityId: batchId,
    details: { totalNet: batch.totalNet },
  });
  void sendApprovedPayouts(batchId).catch((error) =>
    logger.error(`[affiliate] sending withdrawal ${batchId} failed: ${String(error)}`)
  );
}

/** Nothing is paid; the commissions become available again. */
export async function declineWithdrawal(batchId: string, reviewer: Reviewer, reason: string) {
  const batch = await loadWithdrawalForReview(batchId, reviewer);
  await rejectPayoutBatch(batchId);
  await createAuditLog({
    actorId: reviewer.id,
    action: 'AFFILIATE_WITHDRAWAL_DECLINED',
    entity: 'AffiliatePayoutBatch',
    entityId: batchId,
    details: { totalNet: batch.totalNet, reason },
  });
}
