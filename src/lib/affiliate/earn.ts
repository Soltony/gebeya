/**
 * The mini-app Earn page, for customers and agents alike. The person is the
 * phone number the super-app sends, as everywhere else in the mini-app, so
 * agents use it with their own phone and need no other login.
 *
 * Affiliates see their code, the friends they invited and their earnings.
 * Customers who aren't affiliates yet can get their own code when a program
 * has customer sign-up turned on; there is no approval per customer because
 * the program, and with it the sign-up rules, was approved once. Customers who
 * only received a welcome bonus see that here too.
 */
import { startOfMonth } from 'date-fns';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { getPhoneNumbersForAccount } from '@/lib/account-utils';
import { getAsOfDate } from '@/lib/date-utils';
import { SETTLED_STATUSES } from '@/lib/installment-status';
import {
  AFFILIATE_TYPE_LABELS,
  normalizeReferralCode,
  type AffiliateType,
  type ProgramConfig,
  type RewardType,
} from './config';
import { roundMoney } from './engine';
import {
  checkSelfJoinEligibility,
  customCodeProblem,
  describeProgramForAffiliate,
  earningState,
  paymentState,
  POINTS_USE_NOTE,
  SELF_SERVICE,
  summarizeBalances,
  toTitleCase,
  type EarningState,
  type PaymentState,
  type SelfJoinCheck,
  type SelfJoinFacts,
} from './earn-rules';
import { chunk, isUniqueViolation } from './db';
import { findAffiliateForPhones as findAffiliate, ownCommissions, ownPayouts, ownPoints } from './people';
import { getPointsSettings } from './points';
import { AffiliateError, generateCode, getCurrentProgramVersion, loadProgramRuntimes, type ProgramRuntime } from './programs';
import { acceptsCodes } from './referrals';
import { getWithdrawalOffer, type WithdrawalOffer } from './withdrawals';

const FRIEND_LIST_LIMIT = 200;
const EARNINGS_LIMIT = 50;
const PAYMENTS_LIMIT = 20;

export type EarnAffiliate = {
  code: string;
  name: string;
  /** Borrower affiliates are customers; agents, partners and the rest were added by the bank. */
  isCustomer: boolean;
  typeLabel: string;
  suspended: boolean;
  canChangeCode: boolean;
  joinedAt: string;
};

export type EarnProgram = {
  name: string;
  paused: boolean;
  rewardType: RewardType;
  headline: string | null;
  friendOffer: string | null;
  payoutNote: string;
  howItWorks: string[];
  /** In Birr; points programs show it as points. */
  monthlyCap: number | null;
  pointsPerBirr: number;
};

export type FriendProgress = 'JOINED' | 'ORDERED' | 'BORROWED' | 'REPAID' | 'NOT_COUNTED';

export type EarnFriend = {
  id: string;
  /** Last four digits only. */
  phone: string;
  joinedAt: string;
  progress: FriendProgress;
  /** Money earned from this friend. */
  earned: number;
  earnedPoints: number;
};

export type EarnEarning = {
  id: string;
  date: string;
  title: string;
  /** Why it was cancelled or taken back, in customer words. */
  reason: string | null;
  availableFrom: string | null;
  /** Birr; for points rows the reward value behind the points. */
  amount: number;
  /** Set for points rows. */
  points: number | null;
  state: EarningState;
};

export type EarnPoints = {
  balance: number;
  onHold: number;
  nextReleaseAt: string | null;
  /** ETB per point, from the points settings. */
  pointValue: number;
  note: string;
};

export type EarnPayment = {
  id: string;
  date: string;
  amount: number;
  tax: number;
  state: PaymentState;
  /** Asked for by the person on the Earn page (otherwise part of a bank payout). */
  withdrawal: boolean;
};

export type EarnOverview = {
  affiliate: EarnAffiliate | null;
  program: EarnProgram | null;
  /** Set when the person isn't an affiliate and a program lets customers get their own code. */
  join: SelfJoinCheck | null;
  /** Money: show it when the person has money rewards or their program pays money. */
  showMoney: boolean;
  balances: { available: number; onHold: number; beingPaid: number; paidOut: number; nextReleaseAt: string | null };
  /** Null when no program the person earns in allows withdrawals. */
  withdraw: WithdrawalOffer | null;
  /** The points wallet; null when the person has never been in a points program. */
  points: EarnPoints | null;
  thisMonth: { earned: number; earnedPoints: number; friendsJoined: number };
  friends: { total: number; items: EarnFriend[] };
  earnings: EarnEarning[];
  payments: EarnPayment[];
};

type SignUpProgram = ProgramRuntime & { currentConfig: ProgramConfig };

/** The program customers sign up to; programs.assertSelfJoinFree keeps it to one. */
function signUpProgram(runtimes: Map<string, ProgramRuntime>): SignUpProgram | null {
  const candidates = Array.from(runtimes.values()).filter(
    (r): r is SignUpProgram => !!r.currentConfig?.selfJoin.enabled
  );
  return candidates.find((r) => r.status === 'ACTIVE') ?? candidates[0] ?? null;
}

const isSignUpOpen = (program: SignUpProgram) => program.status === 'ACTIVE' && acceptsCodes(program.currentConfig);

const SIGN_UP_PAUSED = 'Invites are paused right now. Please check again later.';

async function selfJoinFacts(phones: string[]): Promise<SelfJoinFacts> {
  const asOf = getAsOfDate();
  const [repaidLoans, unpaid, nplBorrowers] = await Promise.all([
    prisma.loan.count({ where: { borrowerId: { in: phones }, repaymentStatus: 'Paid' } }),
    prisma.loan.findMany({
      where: { borrowerId: { in: phones }, repaymentStatus: 'Unpaid' },
      select: {
        dueDate: true,
        installments: { where: { status: { notIn: SETTLED_STATUSES } }, select: { dueDate: true } },
        _count: { select: { installments: true } },
      },
    }),
    prisma.borrower.count({ where: { id: { in: phones }, status: 'NPL' } }),
  ]);
  // Same rule as the "Overdue" label on the loan dashboard: an open installment,
  // or the loan itself when it has no schedule, is past its due date.
  const hasOverdue = unpaid.some((loan) =>
    loan._count.installments > 0 ? loan.installments.some((i) => i.dueDate < asOf) : loan.dueDate < asOf
  );
  return { repaidLoans, hasOverdue, isNpl: nplBorrowers > 0 };
}

async function customerName(phones: string[], borrowerId: string): Promise<string> {
  const accounts = await prisma.phoneAccount.findMany({
    where: { phoneNumber: { in: phones }, customerName: { not: null } },
    select: { customerName: true, isActive: true, phoneNumber: true },
  });
  const best =
    accounts.find((a) => a.isActive && a.phoneNumber === borrowerId) ?? accounts.find((a) => a.isActive) ?? accounts[0];
  const name = best?.customerName?.trim();
  return name ? toTitleCase(name) : `Customer ${borrowerId.slice(-4)}`;
}

const lastFour = (phone: string) => String(phone ?? '').slice(-4);

const FRIEND_DID: Record<string, string> = {
  LOAN_DISBURSED: 'got a loan',
  LOAN_REPAID: 'repaid a loan',
  BNPL_ORDER_DELIVERED: 'received a credit order',
  DIRECT_ORDER_PAID: 'paid for an order',
};

/** Customer words for a stored take-back reason; admins' own notes are never shown. */
function reasonForCustomer(reason: string | null, beneficiary: string): string | null {
  if (!reason) return null;
  if (reason.startsWith('Loan reversed')) return 'The loan was cancelled.';
  if (reason.startsWith('Customer became NPL')) {
    return beneficiary === 'AFFILIATE' ? 'Your friend stopped repaying.' : 'The loan was not repaid.';
  }
  if (reason.startsWith('Referral rejected')) return 'The referral was not accepted.';
  return 'Adjusted by the bank.';
}

async function describeFriends(
  affiliateId: string,
  referrals: Array<{ id: string; borrowerId: string; attributedAt: Date; status: string }>
): Promise<EarnFriend[]> {
  if (!referrals.length) return [];
  const borrowerIds = Array.from(new Set(referrals.map((r) => r.borrowerId)));
  const loans: Array<{ borrowerId: string; repaymentStatus: string; createdAt: Date }> = [];
  const orders: Array<{ borrowerId: string; createdAt: Date }> = [];
  for (const part of chunk(borrowerIds)) {
    const [partLoans, partOrders] = await Promise.all([
      prisma.loan.findMany({
        where: { borrowerId: { in: part }, repaymentStatus: { not: 'REVERSED' } },
        select: { borrowerId: true, repaymentStatus: true, createdAt: true },
      }),
      prisma.order.findMany({
        where: { borrowerId: { in: part }, status: { not: 'CANCELLED' } },
        select: { borrowerId: true, createdAt: true },
      }),
    ]);
    loans.push(...partLoans);
    orders.push(...partOrders);
  }
  const earned = await prisma.affiliateCommission.groupBy({
    by: ['referralId', 'rewardType'],
    where: { affiliateId, beneficiary: 'AFFILIATE', status: { not: 'REVERSED' }, referralId: { in: referrals.map((r) => r.id) } },
    _sum: { amount: true, points: true },
  });
  const moneyBy = new Map(earned.filter((e) => e.rewardType !== 'POINTS').map((e) => [e.referralId, e._sum.amount ?? 0]));
  const pointsBy = new Map(earned.filter((e) => e.rewardType === 'POINTS').map((e) => [e.referralId, e._sum.points ?? 0]));

  return referrals.map((r) => {
    // Only what the friend did after entering the code counts.
    const theirLoans = loans.filter((l) => l.borrowerId === r.borrowerId && l.createdAt >= r.attributedAt);
    const ordered = orders.some((o) => o.borrowerId === r.borrowerId && o.createdAt >= r.attributedAt);
    let progress: FriendProgress = 'JOINED';
    if (r.status !== 'ACTIVE') progress = 'NOT_COUNTED';
    else if (theirLoans.some((l) => l.repaymentStatus === 'Paid')) progress = 'REPAID';
    else if (theirLoans.length) progress = 'BORROWED';
    else if (ordered) progress = 'ORDERED';
    return {
      id: r.id,
      phone: lastFour(r.borrowerId),
      joinedAt: r.attributedAt.toISOString(),
      progress,
      earned: roundMoney(moneyBy.get(r.id) ?? 0),
      earnedPoints: pointsBy.get(r.id) ?? 0,
    };
  });
}

export async function getEarnOverview(borrowerId: string): Promise<EarnOverview> {
  const phones = await getPhoneNumbersForAccount(borrowerId);
  const [affiliate, runtimes] = await Promise.all([findAffiliate(phones), loadProgramRuntimes()]);
  const commissionsWhere = ownCommissions(affiliate?.id ?? null, phones);
  const payoutsWhere = ownPayouts(affiliate?.id ?? null, phones);
  const monthStart = startOfMonth(new Date());

  const pointsWhere = ownPoints(affiliate?.id ?? null, phones);
  const [totals, nextRelease, recent, adjustments, pointsBalance, pointsSettings, payouts, paidOut, monthEarned, withdraw] = await Promise.all([
    prisma.affiliateCommission.groupBy({
      by: ['status', 'rewardType'],
      where: commissionsWhere,
      _sum: { amount: true, points: true },
      _min: { holdUntil: true },
    }),
    prisma.affiliateCommission.aggregate({
      where: { ...commissionsWhere, status: 'PENDING', rewardType: { not: 'POINTS' } },
      _min: { holdUntil: true },
    }),
    prisma.affiliateCommission.findMany({
      where: commissionsWhere,
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
      take: EARNINGS_LIMIT,
      select: {
        id: true,
        kind: true,
        status: true,
        amount: true,
        rewardType: true,
        points: true,
        beneficiary: true,
        eventType: true,
        eventDate: true,
        holdUntil: true,
        reversedReason: true,
        referral: { select: { borrowerId: true } },
      },
    }),
    // Earned and taken-back points mirror commissions, which are listed already.
    prisma.affiliatePointTransaction.findMany({
      where: { ...pointsWhere, type: 'ADJUST' },
      orderBy: { createdAt: 'desc' },
      take: EARNINGS_LIMIT,
      select: { id: true, points: true, birrValue: true, createdAt: true },
    }),
    prisma.affiliatePointTransaction.aggregate({ where: pointsWhere, _sum: { points: true }, _count: { _all: true } }),
    getPointsSettings(),
    prisma.affiliatePayout.findMany({
      // Admin payouts called off before sending are left out; the person's own
      // withdrawals always show, declined or returned ones included.
      where: { AND: [payoutsWhere, { OR: [{ status: { not: 'CANCELLED' } }, { batch: { source: SELF_SERVICE } }] }] },
      orderBy: { createdAt: 'desc' },
      take: PAYMENTS_LIMIT,
      select: {
        id: true,
        status: true,
        netAmount: true,
        taxAmount: true,
        paidAt: true,
        createdAt: true,
        batch: { select: { status: true, source: true } },
      },
    }),
    prisma.affiliatePayout.aggregate({ where: { ...payoutsWhere, status: 'SUCCESS' }, _sum: { netAmount: true } }),
    affiliate
      ? prisma.affiliateCommission.groupBy({
          by: ['rewardType'],
          where: {
            affiliateId: affiliate.id,
            beneficiary: 'AFFILIATE',
            kind: 'EARNED',
            status: { not: 'REVERSED' },
            eventDate: { gte: monthStart },
          },
          _sum: { amount: true, points: true },
        })
      : Promise.resolve([]),
    getWithdrawalOffer(borrowerId),
  ]);
  const moneyTotals = totals.filter((t) => t.rewardType !== 'POINTS');
  const pointsTotals = totals.filter((t) => t.rewardType === 'POINTS');
  const pendingPoints = pointsTotals.find((t) => t.status === 'PENDING');

  let friends: EarnOverview['friends'] = { total: 0, items: [] };
  let friendsJoined = 0;
  if (affiliate) {
    const [total, joinedThisMonth, referrals] = await Promise.all([
      prisma.affiliateReferral.count({ where: { affiliateId: affiliate.id } }),
      prisma.affiliateReferral.count({ where: { affiliateId: affiliate.id, attributedAt: { gte: monthStart } } }),
      prisma.affiliateReferral.findMany({
        where: { affiliateId: affiliate.id },
        orderBy: { attributedAt: 'desc' },
        take: FRIEND_LIST_LIMIT,
        select: { id: true, borrowerId: true, attributedAt: true, status: true },
      }),
    ]);
    friends = { total, items: await describeFriends(affiliate.id, referrals) };
    friendsJoined = joinedThisMonth;
  }

  // An affiliate sees their own program; anyone else the program they can sign up to.
  const signUp = affiliate ? null : signUpProgram(runtimes);
  const shown = affiliate ? runtimes.get(affiliate.programId) ?? null : signUp;
  const shownConfig = shown?.currentConfig ?? null;
  let program: EarnProgram | null = null;
  if (shown && shownConfig) {
    const text = describeProgramForAffiliate(shownConfig);
    program = {
      name: shown.name,
      paused: shown.status !== 'ACTIVE',
      rewardType: shownConfig.reward.type,
      headline: text.headline,
      friendOffer: text.friendOffer,
      payoutNote: text.payoutNote,
      howItWorks: text.lines,
      monthlyCap: shownConfig.caps.perAffiliatePerMonth,
      pointsPerBirr: shownConfig.reward.pointsPerBirr,
    };
  }

  let join: SelfJoinCheck | null = null;
  if (signUp) {
    join = isSignUpOpen(signUp)
      ? checkSelfJoinEligibility(signUp.currentConfig.selfJoin, await selfJoinFacts(phones))
      : { eligible: false, reasons: [SIGN_UP_PAUSED] };
  }

  const balances = summarizeBalances(moneyTotals.map((t) => ({ status: t.status, amount: t._sum.amount ?? 0 })));
  const paidOutTotal = roundMoney(paidOut._sum.netAmount ?? 0);
  const rewardType = program?.rewardType ?? null;
  const showMoney = moneyTotals.length > 0 || payouts.length > 0 || paidOutTotal > 0 || rewardType === 'MONEY';
  const hasPoints = pointsTotals.length > 0 || pointsBalance._count._all > 0 || rewardType === 'POINTS';
  const monthMoney = monthEarned.find((m) => m.rewardType !== 'POINTS');
  const monthPoints = monthEarned.find((m) => m.rewardType === 'POINTS');

  const commissionRows: EarnEarning[] = recent.map((c) => ({
    id: c.id,
    date: c.eventDate.toISOString(),
    title:
      c.kind === 'CLAWBACK'
        ? 'Taken back'
        : c.beneficiary === 'AFFILIATE'
          ? `Friend ••••${lastFour(c.referral.borrowerId)} ${FRIEND_DID[c.eventType] ?? 'was active'}`
          : 'Welcome bonus',
    reason: reasonForCustomer(c.reversedReason, c.beneficiary),
    availableFrom: c.status === 'PENDING' ? c.holdUntil.toISOString() : null,
    amount: roundMoney(c.amount),
    points: c.rewardType === 'POINTS' ? (c.points ?? 0) : null,
    state: earningState(c.kind, c.status),
  }));
  const adjustmentRows: EarnEarning[] = adjustments.map((a) => ({
    id: a.id,
    date: a.createdAt.toISOString(),
    title: a.points > 0 ? 'Points added by the bank' : 'Points removed by the bank',
    reason: 'Adjusted by the bank.',
    availableFrom: null,
    amount: roundMoney(a.birrValue),
    points: a.points,
    state: a.points > 0 ? 'CREDITED' : 'TAKEN_BACK',
  }));
  const earnings = [...commissionRows, ...adjustmentRows]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, EARNINGS_LIMIT);

  return {
    affiliate: affiliate
      ? {
          code: affiliate.code,
          name: affiliate.name,
          isCustomer: affiliate.type === 'BORROWER',
          typeLabel: AFFILIATE_TYPE_LABELS[affiliate.type as AffiliateType] ?? affiliate.type,
          suspended: affiliate.status !== 'ACTIVE',
          canChangeCode:
            affiliate.source === 'SELF' &&
            !affiliate.codeChangedAt &&
            affiliate.status === 'ACTIVE' &&
            !!shownConfig?.selfJoin.allowCustomCode,
          joinedAt: affiliate.createdAt.toISOString(),
        }
      : null,
    program,
    join,
    showMoney,
    balances: {
      ...balances,
      paidOut: paidOutTotal,
      nextReleaseAt: nextRelease._min.holdUntil?.toISOString() ?? null,
    },
    withdraw,
    points: hasPoints
      ? {
          balance: pointsBalance._sum.points ?? 0,
          onHold: pendingPoints?._sum.points ?? 0,
          nextReleaseAt: pendingPoints?._min.holdUntil?.toISOString() ?? null,
          pointValue: pointsSettings.settings.pointValue,
          note: POINTS_USE_NOTE,
        }
      : null,
    thisMonth: {
      earned: roundMoney(monthMoney?._sum.amount ?? 0),
      earnedPoints: monthPoints?._sum.points ?? 0,
      friendsJoined,
    },
    friends,
    earnings,
    payments: payouts.flatMap((p) => {
      const state = paymentState(p.status, p.batch);
      if (!state) return [];
      return [
        {
          id: p.id,
          date: (p.paidAt ?? p.createdAt).toISOString(),
          amount: p.netAmount,
          tax: p.taxAmount,
          state,
          withdrawal: p.batch.source === SELF_SERVICE,
        },
      ];
    }),
  };
}

/** Whether to show the Earn link in the mini-app, and the balance for its badge. */
export async function getEarnEntry(borrowerId: string): Promise<{ visible: boolean; available: number }> {
  const phones = await getPhoneNumbersForAccount(borrowerId);
  const affiliate = await findAffiliate(phones);
  const where = ownCommissions(affiliate?.id ?? null, phones);
  const [payable, rewards] = await Promise.all([
    prisma.affiliateCommission.aggregate({ where: { ...where, status: 'PAYABLE' }, _sum: { amount: true } }),
    affiliate ? Promise.resolve(1) : prisma.affiliateCommission.count({ where }),
  ]);
  let visible = !!affiliate || rewards > 0;
  if (!visible) {
    const signUp = signUpProgram(await loadProgramRuntimes());
    visible = !!signUp && isSignUpOpen(signUp);
  }
  return { visible, available: roundMoney(payable._sum.amount ?? 0) };
}

/**
 * Gives the customer their own code in the program that has customer sign-up
 * turned on. Calling it again returns the code they already have.
 */
export async function joinAsAffiliate(borrowerId: string): Promise<{ code: string; alreadyJoined: boolean }> {
  const phones = await getPhoneNumbersForAccount(borrowerId);
  const existing = await findAffiliate(phones);
  if (existing) return { code: existing.code, alreadyJoined: true };

  const program = signUpProgram(await loadProgramRuntimes());
  if (!program) throw new AffiliateError('Invites are not available right now.', 409);
  if (!isSignUpOpen(program)) throw new AffiliateError(SIGN_UP_PAUSED, 409);
  const check = checkSelfJoinEligibility(program.currentConfig.selfJoin, await selfJoinFacts(phones));
  if (!check.eligible) throw new AffiliateError(check.reasons[0], 403);

  const name = await customerName(phones, borrowerId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const affiliate = await prisma.affiliate.create({
        data: {
          code: generateCode(),
          type: 'BORROWER',
          source: 'SELF',
          name,
          phoneNumber: borrowerId,
          programId: program.id,
          status: 'ACTIVE',
        },
      });
      await createAuditLog({
        actorId: borrowerId,
        action: 'AFFILIATE_SELF_JOINED',
        entity: 'Affiliate',
        entityId: affiliate.id,
        details: { programId: program.id, programVersion: program.currentVersion, code: affiliate.code },
      });
      return { code: affiliate.code, alreadyJoined: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either a second tap already created it, or the random code was taken.
      const raced = await prisma.affiliate.findUnique({ where: { phoneNumber: borrowerId }, select: { code: true } });
      if (raced) return { code: raced.code, alreadyJoined: true };
    }
  }
  throw new AffiliateError('Could not create your code. Please try again.', 500);
}

/** Lets a customer who got their own code replace it once with one they choose. */
export async function changeOwnCode(borrowerId: string, rawCode: string): Promise<{ code: string }> {
  const code = normalizeReferralCode(rawCode);
  const problem = customCodeProblem(code);
  if (problem) throw new AffiliateError(problem, 400);

  const phones = await getPhoneNumbersForAccount(borrowerId);
  const affiliate = await findAffiliate(phones);
  if (!affiliate) throw new AffiliateError('Get your code first.', 404);
  if (affiliate.source !== 'SELF') throw new AffiliateError("Your code was set by the bank and can't be changed here.", 403);
  if (affiliate.codeChangedAt) throw new AffiliateError('You have already changed your code once.', 409);
  if (affiliate.status !== 'ACTIVE') throw new AffiliateError("Your code can't be changed while your account is on hold.", 403);
  const { config } = await getCurrentProgramVersion(affiliate.programId);
  if (!config.selfJoin.allowCustomCode) throw new AffiliateError("Codes can't be changed in this program.", 403);
  if (code === affiliate.code) throw new AffiliateError('That is already your code.', 400);

  let res;
  try {
    res = await prisma.affiliate.updateMany({
      where: { id: affiliate.id, codeChangedAt: null },
      data: { code, codeChangedAt: new Date() },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AffiliateError('That code is taken. Please try another one.', 409);
    throw error;
  }
  if (res.count === 0) throw new AffiliateError('You have already changed your code once.', 409);

  await createAuditLog({
    actorId: borrowerId,
    action: 'AFFILIATE_CODE_CHANGED',
    entity: 'Affiliate',
    entityId: affiliate.id,
    details: { from: affiliate.code, to: code },
  });
  return { code };
}
