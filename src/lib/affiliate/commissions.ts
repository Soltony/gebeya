/**
 * The daily affiliate commission job.
 *
 * Instead of hooking into the disbursement and repayment code paths, it reads
 * what already happened (loans, payments, orders) for every referred customer
 * and records commissions idempotently, so re-running it never pays twice and
 * a failure here can never block a loan or a repayment.
 *
 * Per referred customer it:
 *  1. takes back commissions whose loan was reversed (always) or whose
 *     customer became NPL (when the program says so);
 *  2. runs new events through the rules of the program version locked on the
 *     referral, applying occurrence limits and caps.
 * Then it releases commissions whose hold period ended and prepares scheduled
 * payout drafts.
 */
import { format, startOfMonth, endOfMonth, subDays } from 'date-fns';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getPhoneNumbersForAccount } from '@/lib/account-utils';
import { REPAYMENT_BEHAVIORS, readStoredConfig, type Beneficiary, type ProgramConfig, type RepaymentBehavior } from './config';
import {
  deriveRepaymentBehavior,
  evaluateEvent,
  holdUntilFor,
  isDuringPause,
  isWithinReferralWindow,
  remainingRoom,
  roundMoney,
  type EventFacts,
} from './engine';
import { postCommissionAccrual } from './ledger';
import { isUniqueViolation } from './db';
import { rewardFor } from './earn-rules';
import { postPoints } from './points';
import { loadProgramRuntimes, type ProgramRuntime } from './programs';
import { prepareScheduledPayoutDrafts } from './payouts';

const describeSource = (c: { eventType: string; sourceType: string; sourceId: string }) =>
  `${c.eventType} (${c.sourceType.toLowerCase()} ${c.sourceId})`;

/** Whose points wallet a commission belongs to: the affiliate's, or the referred customer's. */
const pointsOwner = (c: { beneficiary: string; beneficiaryPhone: string; affiliateId: string; ruleSnapshot: string }) => {
  let programId: string | null = null;
  try {
    programId = JSON.parse(c.ruleSnapshot)?.programId ?? null;
  } catch {
    programId = null;
  }
  return { phone: c.beneficiaryPhone, affiliateId: c.beneficiary === 'AFFILIATE' ? c.affiliateId : null, programId };
};

/**
 * Takes back one EARNED commission. Not yet paid or credited: it is cancelled.
 * Money already in a payout or paid: a negative CLAWBACK row is added, which
 * the next payout deducts. Points already credited: the CLAWBACK row removes
 * them from the wallet at once (the balance may go below zero). Returns false
 * when there was nothing to take back.
 */
export async function takeBackCommission(commissionId: string, reason: string, now = new Date()): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const c = await tx.affiliateCommission.findUnique({ where: { id: commissionId } });
      if (!c || c.kind !== 'EARNED' || c.status === 'REVERSED') return false;
      const clawbackKey = `CLAWBACK:${c.id}`;
      const alreadyTakenBack = await tx.affiliateCommission.findUnique({
        where: { idempotencyKey: clawbackKey },
        select: { id: true },
      });
      if (alreadyTakenBack) return false;
      const onLedger = c.ledgerPosted && !!c.providerId;

      if (c.status === 'PENDING' || c.status === 'PAYABLE') {
        const res = await tx.affiliateCommission.updateMany({
          where: { id: c.id, status: c.status },
          data: { status: 'REVERSED', reversedReason: reason, reversedAt: now },
        });
        if (res.count === 0) return false;
        if (onLedger) {
          await postCommissionAccrual(tx, {
            providerId: c.providerId!,
            amount: -c.amount,
            date: now,
            description: `Affiliate commission cancelled (${reason}): ${describeSource(c)}`,
          });
        }
        return true;
      }

      const points = c.rewardType === 'POINTS';
      const clawback = await tx.affiliateCommission.create({
        data: {
          idempotencyKey: clawbackKey,
          kind: 'CLAWBACK',
          clawbackOfId: c.id,
          referralId: c.referralId,
          affiliateId: c.affiliateId,
          beneficiary: c.beneficiary,
          beneficiaryPhone: c.beneficiaryPhone,
          ruleId: c.ruleId,
          ruleName: c.ruleName,
          eventType: c.eventType,
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          loanId: c.loanId,
          orderId: c.orderId,
          providerId: c.providerId,
          fundedBy: c.fundedBy,
          baseAmount: c.baseAmount,
          amount: -c.amount,
          rewardType: c.rewardType,
          points: points ? -(c.points ?? 0) : null,
          // Money is deducted from the next payout; points leave the wallet now.
          status: points ? 'CREDITED' : 'PAYABLE',
          eventDate: now,
          holdUntil: now,
          payableAt: now,
          ruleSnapshot: c.ruleSnapshot,
          ledgerPosted: onLedger,
          reversedReason: reason,
        },
      });
      if (points && c.points) {
        await postPoints(tx, {
          idempotencyKey: `REVERSAL:${c.id}`,
          ...pointsOwner(c),
          type: 'REVERSAL',
          points: -c.points,
          birrValue: -c.amount,
          commissionId: clawback.id,
          note: reason,
        });
      }
      if (onLedger) {
        await postCommissionAccrual(tx, {
          providerId: c.providerId!,
          amount: -c.amount,
          date: now,
          description: `Affiliate commission taken back (${reason}): ${describeSource(c)}`,
        });
      }
      return true;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Ends the hold of due commissions. Money ones become PAYABLE (provider-funded
 * ones are booked on the provider ledger); points ones become CREDITED and
 * their points are added to the wallet. `commissionIds` limits it to those rows.
 */
export async function releaseHeldCommissions(now = new Date(), options: { commissionIds?: string[] } = {}): Promise<number> {
  let released = 0;
  const attempted = new Set<string>();
  for (;;) {
    const due = await prisma.affiliateCommission.findMany({
      where: {
        status: 'PENDING',
        holdUntil: { lte: now },
        ...(options.commissionIds ? { id: { in: options.commissionIds } } : {}),
      },
      orderBy: { holdUntil: 'asc' },
      take: 500,
    });
    const fresh = due.filter((c) => !attempted.has(c.id));
    if (!fresh.length) break;
    for (const c of fresh) {
      attempted.add(c.id);
      if (c.rewardType === 'POINTS') {
        try {
          const ok = await prisma.$transaction(async (tx) => {
            const res = await tx.affiliateCommission.updateMany({
              where: { id: c.id, status: 'PENDING' },
              data: { status: 'CREDITED', payableAt: now },
            });
            if (res.count === 0) return false;
            // Points are not booked on provider ledgers until finance decides how.
            if (c.points) {
              await postPoints(tx, {
                idempotencyKey: `EARN:${c.id}`,
                ...pointsOwner(c),
                type: 'EARN',
                points: c.points,
                birrValue: c.amount,
                commissionId: c.id,
                note: c.ruleName,
              });
            }
            return true;
          });
          if (ok) released++;
        } catch (error) {
          logger.error(`[affiliate] failed to credit points for commission ${c.id}: ${String(error)}`);
        }
        continue;
      }
      const postToLedger = c.fundedBy === 'PROVIDER' && !!c.providerId;
      try {
        const ok = await prisma.$transaction(async (tx) => {
          const res = await tx.affiliateCommission.updateMany({
            where: { id: c.id, status: 'PENDING' },
            data: { status: 'PAYABLE', payableAt: now, ledgerPosted: postToLedger },
          });
          if (res.count === 0) return false;
          if (postToLedger) {
            await postCommissionAccrual(tx, {
              providerId: c.providerId!,
              amount: c.amount,
              date: now,
              description: `Affiliate commission payable: ${describeSource(c)}`,
            });
          }
          return true;
        });
        if (ok) released++;
      } catch (error) {
        logger.error(`[affiliate] failed to release commission ${c.id}: ${String(error)}`);
      }
    }
    if (due.length < 500) break;
  }
  return released;
}

async function feesCollectedForLoan(loanId: string): Promise<number> {
  // Fee income is credited only when money is collected (accruals post to
  // Receivable only), so Income credits minus debits = fees actually collected.
  const rows = await prisma.ledgerEntry.groupBy({
    by: ['type'],
    where: { journalEntry: { loanId }, ledgerAccount: { type: 'Income' } },
    _sum: { amount: true },
  });
  let total = 0;
  for (const row of rows) {
    const amount = row._sum.amount ?? 0;
    if (row.type === 'Credit') total += amount;
    else if (row.type === 'Debit') total -= amount;
  }
  return roundMoney(Math.max(0, total));
}

const asBehavior = (value: string | null): RepaymentBehavior | null =>
  value && (REPAYMENT_BEHAVIORS as readonly string[]).includes(value) ? (value as RepaymentBehavior) : null;

/** Builds every commission event for one referred customer from loans and orders. */
async function collectEvents(phones: string[], attributedAt: Date) {
  const loans = await prisma.loan.findMany({
    where: { borrowerId: { in: phones }, createdAt: { gte: attributedAt } },
    select: {
      id: true,
      productId: true,
      loanAmount: true,
      serviceFee: true,
      disbursedDate: true,
      dueDate: true,
      repaymentStatus: true,
      repaymentBehavior: true,
      createdAt: true,
      updatedAt: true,
      product: { select: { providerId: true } },
      payments: { select: { date: true }, orderBy: { date: 'desc' }, take: 1 },
    },
  });
  const loanIds = loans.map((l) => l.id);
  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { borrowerId: { in: phones }, createdAt: { gte: attributedAt } },
        ...(loanIds.length ? [{ loanId: { in: loanIds } }] : []),
      ],
    },
    select: {
      id: true,
      merchantId: true,
      loanId: true,
      paymentType: true,
      status: true,
      totalAmount: true,
      createdAt: true,
      updatedAt: true,
      orderItems: { select: { item: { select: { categoryId: true } } } },
    },
  });
  const orderByLoanId = new Map(orders.filter((o) => o.loanId).map((o) => [o.loanId as string, o]));
  const categoriesOf = (order: (typeof orders)[number]) =>
    Array.from(new Set(order.orderItems.map((oi) => oi.item.categoryId)));

  const events: EventFacts[] = [];
  const reversedLoanIds = new Set<string>();

  for (const loan of loans) {
    if (loan.repaymentStatus === 'REVERSED') {
      reversedLoanIds.add(loan.id);
      continue;
    }
    const order = orderByLoanId.get(loan.id);
    const base: EventFacts = {
      event: 'LOAN_DISBURSED',
      sourceType: 'LOAN',
      sourceId: loan.id,
      eventDate: loan.disbursedDate,
      // A BNPL purchase starts when the order is placed, not on delivery.
      sourceDate: order ? order.createdAt : loan.createdAt,
      loanId: loan.id,
      orderId: order?.id ?? null,
      providerId: loan.product.providerId,
      productId: loan.productId,
      loanKind: order ? 'BNPL' : 'PERSONAL',
      merchantId: order?.merchantId ?? null,
      categoryIds: order ? categoriesOf(order) : [],
      repaymentBehavior: null,
      principal: loan.loanAmount,
      serviceFee: loan.serviceFee,
      feesCollected: null,
      orderTotal: order?.totalAmount ?? null,
    };
    events.push(base);
    if (loan.repaymentStatus === 'Paid') {
      const lastPayment = loan.payments[0]?.date ?? loan.updatedAt;
      events.push({
        ...base,
        event: 'LOAN_REPAID',
        eventDate: lastPayment,
        repaymentBehavior: asBehavior(loan.repaymentBehavior) ?? deriveRepaymentBehavior(lastPayment, loan.dueDate),
      });
    }
    if (order && order.paymentType === 'BNPL') {
      events.push({ ...base, event: 'BNPL_ORDER_DELIVERED', sourceType: 'ORDER', sourceId: order.id });
    }
  }

  for (const order of orders) {
    if (order.paymentType !== 'DIRECT' || order.status !== 'DELIVERED') continue;
    events.push({
      event: 'DIRECT_ORDER_PAID',
      sourceType: 'ORDER',
      sourceId: order.id,
      // Orders keep no paid/delivered timestamp; the callback's update is the closest.
      eventDate: order.updatedAt,
      sourceDate: order.createdAt,
      loanId: null,
      orderId: order.id,
      providerId: null,
      productId: null,
      loanKind: null,
      merchantId: order.merchantId,
      categoryIds: categoriesOf(order),
      repaymentBehavior: null,
      principal: null,
      serviceFee: null,
      feesCollected: null,
      orderTotal: order.totalAmount,
    });
  }

  events.sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
  return { events, reversedLoanIds };
}

/** Running totals for caps, shared by every referral in one run. */
class CapTracker {
  private budget = new Map<string, number>();
  private month = new Map<string, number>();

  async budgetUsed(programId: string): Promise<number> {
    if (!this.budget.has(programId)) {
      const agg = await prisma.affiliateCommission.aggregate({
        where: { kind: 'EARNED', status: { not: 'REVERSED' }, referral: { programVersion: { programId } } },
        _sum: { amount: true },
      });
      this.budget.set(programId, agg._sum.amount ?? 0);
    }
    return this.budget.get(programId)!;
  }

  async monthUsed(affiliateId: string, date: Date): Promise<number> {
    const key = `${affiliateId}:${format(date, 'yyyy-MM')}`;
    if (!this.month.has(key)) {
      const agg = await prisma.affiliateCommission.aggregate({
        where: {
          affiliateId,
          kind: 'EARNED',
          beneficiary: 'AFFILIATE',
          status: { not: 'REVERSED' },
          eventDate: { gte: startOfMonth(date), lte: endOfMonth(date) },
        },
        _sum: { amount: true },
      });
      this.month.set(key, agg._sum.amount ?? 0);
    }
    return this.month.get(key)!;
  }

  add(programId: string, affiliateId: string, date: Date, beneficiary: Beneficiary, amount: number) {
    this.budget.set(programId, (this.budget.get(programId) ?? 0) + amount);
    if (beneficiary === 'AFFILIATE') {
      const key = `${affiliateId}:${format(date, 'yyyy-MM')}`;
      this.month.set(key, (this.month.get(key) ?? 0) + amount);
    }
  }
}

type ReferralForJob = {
  id: string;
  borrowerId: string;
  attributedAt: Date;
  affiliateId: string;
  affiliate: { id: string; phoneNumber: string; status: string };
  programVersion: { id: string; programId: string; version: number; config: string };
};

async function processReferral(
  referral: ReferralForJob,
  program: ProgramRuntime,
  locked: ProgramConfig | null,
  caps: CapTracker,
  now: Date
): Promise<{ created: number; takenBack: number }> {
  const phones = await getPhoneNumbersForAccount(referral.borrowerId);
  const [{ events, reversedLoanIds }, borrowers, existing] = await Promise.all([
    collectEvents(phones, referral.attributedAt),
    prisma.borrower.findMany({ where: { id: { in: phones } }, select: { status: true } }),
    prisma.affiliateCommission.findMany({
      where: { referralId: referral.id },
      select: {
        id: true,
        kind: true,
        idempotencyKey: true,
        ruleId: true,
        beneficiary: true,
        status: true,
        loanId: true,
        eventDate: true,
        amount: true,
        clawbackOfId: true,
      },
    }),
  ]);
  const isNpl = borrowers.some((b) => b.status === 'NPL');
  const takeBackOnNpl = !!locked?.clawback.onNpl && isNpl;

  // 1. Take-backs.
  const clawedBack = new Set(existing.filter((c) => c.kind === 'CLAWBACK' && c.clawbackOfId).map((c) => c.clawbackOfId!));
  const live = existing.filter((c) => c.kind === 'EARNED' && c.status !== 'REVERSED' && !clawedBack.has(c.id));
  const reasons = new Map<string, string>();
  for (const c of live) {
    if (c.loanId && reversedLoanIds.has(c.loanId)) reasons.set(c.id, 'Loan reversed');
  }
  if (takeBackOnNpl && locked) {
    const since = subDays(now, locked.clawback.nplWindowDays);
    for (const c of live) {
      if (!reasons.has(c.id) && c.eventDate >= since) reasons.set(c.id, 'Customer became NPL');
    }
  }
  let takenBack = 0;
  for (const [id, reason] of reasons) {
    if (await takeBackCommission(id, reason, now)) takenBack++;
  }

  // 2. New commissions: none while the customer is NPL, the affiliate is
  // suspended (caught up on reactivation) or the locked config is unreadable.
  if (!locked || takeBackOnNpl || referral.affiliate.status !== 'ACTIVE') return { created: 0, takenBack };

  const counted = live.filter((c) => !reasons.has(c.id));
  const recordedKeys = new Set(existing.map((c) => c.idempotencyKey));
  const counts = new Map<string, number>();
  let perReferralUsed = 0;
  for (const c of counted) {
    const key = `${c.ruleId}:${c.beneficiary}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (c.beneficiary === 'AFFILIATE') perReferralUsed += c.amount;
  }

  // Spending caps follow the program's latest version; the promise to the
  // affiliate (rules, per-customer cap, hold, take-backs) follows the locked one.
  const spend = program.currentConfig ?? locked;
  const feeRules = locked.commissionRules.filter(
    (r) => r.enabled && r.event === 'LOAN_REPAID' && r.calc.type === 'PERCENT' && r.calc.base === 'FEES_COLLECTED'
  );
  let created = 0;

  for (const facts of events) {
    if (facts.eventDate.getTime() > now.getTime()) continue;
    if (!isWithinReferralWindow(locked, referral.attributedAt, facts.sourceDate)) continue;
    if (isDuringPause(facts.eventDate, program.pausedAt, program.pausedPeriods)) continue;

    const keyFor = (ruleId: string, beneficiary: Beneficiary) =>
      `EARNED:${referral.id}:${ruleId}:${beneficiary}:${facts.sourceId}`;

    if (
      facts.event === 'LOAN_REPAID' &&
      facts.loanId &&
      feeRules.some((r) => !recordedKeys.has(keyFor(r.id, r.beneficiary)))
    ) {
      facts.feesCollected = await feesCollectedForLoan(facts.loanId);
    }

    const lines = evaluateEvent(locked, facts, {
      priorCount: (ruleId, beneficiary) => counts.get(`${ruleId}:${beneficiary}`) ?? 0,
      isRecorded: (ruleId, beneficiary) => recordedKeys.has(keyFor(ruleId, beneficiary)),
      rooms: {
        perReferral: remainingRoom(locked.caps.perReferralTotal, perReferralUsed),
        perAffiliateMonth: remainingRoom(
          spend.caps.perAffiliatePerMonth,
          await caps.monthUsed(referral.affiliateId, facts.eventDate)
        ),
        budget: remainingRoom(spend.caps.programBudget, await caps.budgetUsed(program.id)),
      },
    });

    for (const line of lines) {
      if (line.status !== 'PAYS') continue;
      const key = keyFor(line.rule.id, line.beneficiary);
      try {
        await prisma.affiliateCommission.create({
          data: {
            idempotencyKey: key,
            kind: 'EARNED',
            referralId: referral.id,
            affiliateId: referral.affiliateId,
            beneficiary: line.beneficiary,
            beneficiaryPhone: line.beneficiary === 'AFFILIATE' ? referral.affiliate.phoneNumber : referral.borrowerId,
            ruleId: line.rule.id,
            ruleName: line.rule.name,
            eventType: facts.event,
            sourceType: facts.sourceType,
            sourceId: facts.sourceId,
            loanId: facts.loanId,
            orderId: facts.orderId,
            providerId: facts.providerId,
            fundedBy: line.fundedBy,
            baseAmount: line.baseAmount,
            amount: line.amount,
            // Money or points, and the earning rate, follow the program's latest
            // version, like its payout settings; the row keeps them from now on.
            ...rewardFor(spend.reward, line.amount),
            status: 'PENDING',
            eventDate: facts.eventDate,
            holdUntil: holdUntilFor(locked, facts.eventDate),
            ruleSnapshot: JSON.stringify({
              programId: program.id,
              programVersion: referral.programVersion.version,
              rule: line.rule,
              calculatedAmount: line.calculatedAmount,
              cappedBy: line.cappedBy,
            }),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          recordedKeys.add(key);
          continue;
        }
        throw error;
      }
      recordedKeys.add(key);
      const countKey = `${line.rule.id}:${line.beneficiary}`;
      counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
      if (line.beneficiary === 'AFFILIATE') perReferralUsed += line.amount;
      caps.add(program.id, referral.affiliateId, facts.eventDate, line.beneficiary, line.amount);
      created++;
    }
  }

  return { created, takenBack };
}

export type AffiliateJobResult = {
  referralsScanned: number;
  commissionsCreated: number;
  commissionsTakenBack: number;
  commissionsReleased: number;
  payoutDraftsPrepared: number;
  errors: number;
};

export async function runAffiliateCommissionsOnce(options: { now?: Date } = {}): Promise<AffiliateJobResult> {
  const now = options.now ?? new Date();
  const result: AffiliateJobResult = {
    referralsScanned: 0,
    commissionsCreated: 0,
    commissionsTakenBack: 0,
    commissionsReleased: 0,
    payoutDraftsPrepared: 0,
    errors: 0,
  };

  const runtimes = await loadProgramRuntimes();
  const referrals = await prisma.affiliateReferral.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      borrowerId: true,
      attributedAt: true,
      affiliateId: true,
      affiliate: { select: { id: true, phoneNumber: true, status: true } },
      programVersion: { select: { id: true, programId: true, version: true, config: true } },
    },
    orderBy: { attributedAt: 'asc' },
  });

  const lockedConfigs = new Map<string, ProgramConfig | null>();
  const caps = new CapTracker();

  for (const referral of referrals) {
    const program = runtimes.get(referral.programVersion.programId);
    if (!program) continue;
    if (!lockedConfigs.has(referral.programVersion.id)) {
      try {
        lockedConfigs.set(referral.programVersion.id, readStoredConfig(referral.programVersion.config));
      } catch (error) {
        lockedConfigs.set(referral.programVersion.id, null);
        logger.error(`[affiliate] program version ${referral.programVersion.id} has an invalid config: ${String(error)}`);
      }
    }
    result.referralsScanned++;
    try {
      const outcome = await processReferral(referral, program, lockedConfigs.get(referral.programVersion.id) ?? null, caps, now);
      result.commissionsCreated += outcome.created;
      result.commissionsTakenBack += outcome.takenBack;
    } catch (error) {
      result.errors++;
      logger.error(`[affiliate] referral ${referral.id} failed: ${String(error)}`);
    }
  }

  result.commissionsReleased = await releaseHeldCommissions(now);
  try {
    result.payoutDraftsPrepared = await prepareScheduledPayoutDrafts(now, runtimes);
  } catch (error) {
    result.errors++;
    logger.error(`[affiliate] scheduled payout drafts failed: ${String(error)}`);
  }

  logger.info(
    `[affiliate] run finished referrals=${result.referralsScanned} created=${result.commissionsCreated} takenBack=${result.commissionsTakenBack} released=${result.commissionsReleased} drafts=${result.payoutDraftsPrepared} errors=${result.errors}`
  );
  return result;
}
