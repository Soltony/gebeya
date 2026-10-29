/**
 * Rules and wording for the mini-app's Earn page: who may get their own code,
 * which custom codes are allowed, how commissions add up into balances, and the
 * program explained in customer words.
 *
 * Shared by client and server code: keep it free of Prisma and Node-only imports.
 */
import {
  BASE_LABELS,
  formatMoney,
  formatPoints,
  pointsForAmount,
  type CommissionEvent,
  type CommissionRule,
  type PointUse,
  type PointsSettings,
  type ProgramConfig,
} from './config';
import { roundMoney } from './engine';

// ---------------------------------------------------------------------------
// Getting a code
// ---------------------------------------------------------------------------

export type SelfJoinFacts = {
  /** Fully repaid loans across all of the customer's phone numbers. */
  repaidLoans: number;
  /** An unpaid loan or installment is past its due date. */
  hasOverdue: boolean;
  /** The customer is flagged NPL. */
  isNpl: boolean;
};

export type SelfJoinCheck = { eligible: boolean; reasons: string[] };

/** Whether a customer may get their own code, with the reasons (in customer words) when not. */
export function checkSelfJoinEligibility(settings: ProgramConfig['selfJoin'], facts: SelfJoinFacts): SelfJoinCheck {
  const reasons: string[] = [];
  // NPL always blocks; ordinary overdue payments only when the program says so.
  if (facts.isNpl) {
    reasons.push('One of your loans is long overdue. Repay it to get your code.');
  } else if (settings.blockIfOverdue && facts.hasOverdue) {
    reasons.push('You have an overdue payment. Pay it to get your code.');
  }
  if (facts.repaidLoans < settings.minRepaidLoans) {
    reasons.push(
      settings.minRepaidLoans === 1
        ? 'Fully repay your first loan to get your code.'
        : `Fully repay ${settings.minRepaidLoans} loans to get your code (you have repaid ${facts.repaidLoans}).`
    );
  }
  return { eligible: reasons.length === 0, reasons };
}

export const CUSTOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;

// Words that could make a code pass for the bank or its staff. Matched
// anywhere in the code.
export const RESERVED_CODE_WORDS = ['NIB', 'BANK', 'ADMIN', 'OFFICIAL', 'SUPPORT', 'LOANFLOW'];

/** Why a customer's chosen code can't be used, or null when it can. Expects a normalized code. */
export function customCodeProblem(code: string): string | null {
  if (!CUSTOM_CODE_PATTERN.test(code)) return 'Use 4 to 12 letters or numbers, with no spaces.';
  if (!/[A-Z]/.test(code)) return 'Include at least one letter.';
  if (RESERVED_CODE_WORDS.some((word) => code.includes(word))) return 'This code is reserved. Please choose another one.';
  return null;
}

/** "ABEBE KEBEDE ALEMU" -> "Abebe Kebede Alemu". */
export function toTitleCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

/** "Abebe Kebede Alemu" -> "Abebe K.": how a customer affiliate is named to the friends they invite. */
export function shortPersonName(name: string): string {
  const [first, second] = name.trim().split(/\s+/);
  if (!first) return name;
  return second ? `${first} ${second[0].toUpperCase()}.` : first;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** Commission totals per status (a groupBy row); take-backs are negative amounts. */
export type CommissionTotal = { status: string; amount: number };

export type WalletBalances = {
  /** Paid in the next payout; negative while a take-back is being recovered. */
  available: number;
  /** Earned, still inside the hold period. */
  onHold: number;
  /** In a payout that is being approved or sent. */
  beingPaid: number;
};

export function summarizeBalances(totals: CommissionTotal[]): WalletBalances {
  const sum = (status: string) =>
    roundMoney(totals.filter((t) => t.status === status).reduce((acc, t) => acc + (t.amount || 0), 0));
  return { available: sum('PAYABLE'), onHold: sum('PENDING'), beingPaid: sum('IN_PAYOUT') };
}

export type EarningState = 'ON_HOLD' | 'AVAILABLE' | 'BEING_PAID' | 'PAID' | 'CREDITED' | 'CANCELLED' | 'TAKEN_BACK';

/** How one commission row reads on the Earn page. */
export function earningState(kind: string, status: string): EarningState {
  if (kind === 'CLAWBACK') return 'TAKEN_BACK';
  switch (status) {
    case 'PENDING':
      return 'ON_HOLD';
    case 'PAYABLE':
      return 'AVAILABLE';
    case 'IN_PAYOUT':
      return 'BEING_PAID';
    case 'PAID':
      return 'PAID';
    case 'CREDITED':
      return 'CREDITED';
    default:
      return 'CANCELLED';
  }
}

export type PaymentState = 'PAID' | 'PROCESSING' | 'IN_REVIEW' | 'DELAYED' | 'DECLINED' | 'RETURNED';

export const SELF_SERVICE = 'SELF_SERVICE';

/**
 * How a payout reads to the person paid. Null for admin payouts that were
 * called off before sending: they never moved money and the person never saw them.
 */
export function paymentState(payoutStatus: string, batch: { status: string; source: string }): PaymentState | null {
  const withdrawal = batch.source === SELF_SERVICE;
  if (payoutStatus === 'SUCCESS') return 'PAID';
  // An admin checks a failed transfer before retrying it or releasing the money.
  if (payoutStatus === 'FAILED') return 'DELAYED';
  if (payoutStatus === 'CANCELLED') {
    if (!withdrawal) return null;
    return batch.status === 'REJECTED' ? 'DECLINED' : 'RETURNED';
  }
  if (payoutStatus === 'PENDING_APPROVAL' && withdrawal) return 'IN_REVIEW';
  return 'PROCESSING';
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

/** What is still allowed under the daily and monthly limits; null when there is no limit. */
export function withdrawalCap(
  settings: ProgramConfig['withdraw'],
  used: { today: number; month: number }
): number | null {
  const rooms: number[] = [];
  if (settings.maxPerDay != null) rooms.push(settings.maxPerDay - used.today);
  if (settings.maxPerMonth != null) rooms.push(settings.maxPerMonth - used.month);
  return rooms.length ? Math.max(0, roundMoney(Math.min(...rooms))) : null;
}

/**
 * Why the person's earnings in one program can't be withdrawn now, in customer
 * words. Earnings can't be split, so one bigger than the room left waits.
 */
export function withdrawalBlockedReason(
  settings: ProgramConfig['withdraw'],
  used: { today: number; month: number },
  rows: Array<{ amount: number }>
): string {
  const wanted = roundMoney(rows.reduce((sum, r) => sum + r.amount, 0));
  if (wanted < settings.minimum) return `You can withdraw from ${formatMoney(settings.minimum)}.`;
  const biggest = Math.max(...rows.map((r) => r.amount));
  if (biggest > Math.min(settings.maxPerDay ?? Infinity, settings.maxPerMonth ?? Infinity)) {
    return 'One of your earnings is above the withdrawal limit, so it is paid to you in a regular payout.';
  }
  const dayLeft = settings.maxPerDay != null ? settings.maxPerDay - used.today : Infinity;
  const monthLeft = settings.maxPerMonth != null ? settings.maxPerMonth - used.month : Infinity;
  return dayLeft <= monthLeft ? "You can't withdraw more today. Please try again tomorrow." : "You can't withdraw more this month.";
}

/**
 * Picks the commissions one withdrawal pays: every take-back first (they are
 * always netted, so they can't be left behind), then the oldest earnings while
 * the total stays within `cap`.
 */
export function selectForWithdrawal<T extends { amount: number; eventDate: Date | string }>(
  rows: T[],
  cap: number | null
): { rows: T[]; total: number } {
  const picked = rows.filter((r) => r.amount < 0);
  let total = picked.reduce((sum, r) => sum + r.amount, 0);
  const earnings = rows
    .filter((r) => r.amount >= 0)
    .sort((a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime());
  for (const row of earnings) {
    if (cap != null && roundMoney(total + row.amount) > cap) continue;
    picked.push(row);
    total += row.amount;
  }
  return { rows: picked, total: roundMoney(total) };
}

// ---------------------------------------------------------------------------
// Using points
// ---------------------------------------------------------------------------

/** Birr that `points` buy at `rate` ETB per point. */
export function birrForPoints(points: number, rate: number): number {
  return roundMoney(points * rate);
}

/** Whole points needed to pay `birr` at `rate` ETB per point (rounded up, never short). */
export function pointsNeeded(birr: number, rate: number): number {
  return Math.ceil(birr / rate - 1e-9);
}

export type PointsUseSettings = PointsSettings[PointUse];

/** Why `points` can't be used now, in customer words, or null when they can. */
export function pointsUseProblem(
  use: PointsUseSettings,
  input: { points: number; balance: number; usedToday: number; usedThisMonth: number }
): string | null {
  if (!use.enabled) return 'This is not available right now.';
  if (!Number.isInteger(input.points) || input.points <= 0) return 'Enter a whole number of points.';
  if (input.points < use.minPoints) return `Use at least ${formatPoints(use.minPoints)}.`;
  if (input.points > input.balance) return `You only have ${formatPoints(Math.max(0, input.balance))}.`;
  if (use.maxPointsPerDay != null && input.usedToday + input.points > use.maxPointsPerDay) {
    const left = use.maxPointsPerDay - input.usedToday;
    return left > 0 ? `You can use up to ${formatPoints(left)} more today.` : "You reached today's limit. Please try again tomorrow.";
  }
  if (use.maxPointsPerMonth != null && input.usedThisMonth + input.points > use.maxPointsPerMonth) {
    const left = use.maxPointsPerMonth - input.usedThisMonth;
    return left > 0 ? `You can use up to ${formatPoints(left)} more this month.` : "You reached this month's limit.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The program in customer words
// ---------------------------------------------------------------------------

const FRIEND_DOES: Record<CommissionEvent, string> = {
  LOAN_DISBURSED: 'gets a loan',
  LOAN_REPAID: 'fully repays a loan',
  BNPL_ORDER_DELIVERED: 'receives a shop order bought on credit',
  DIRECT_ORDER_PAID: 'pays for a shop order',
};

const THEY_DO: Record<CommissionEvent, string> = {
  LOAN_DISBURSED: 'get a loan',
  LOAN_REPAID: 'fully repay a loan',
  BNPL_ORDER_DELIVERED: 'receive a shop order bought on credit',
  DIRECT_ORDER_PAID: 'pay for a shop order',
};

type Reward = ProgramConfig['reward'];

const MONEY_REWARD: Reward = { type: 'MONEY', pointsPerBirr: 10 };

/** A Birr amount as the program pays it: money, or the points it turns into. */
function rewardWords(amount: number, reward: Reward): string {
  return reward.type === 'POINTS' ? formatPoints(pointsForAmount(amount, reward.pointsPerBirr)) : formatMoney(amount);
}

/** Always followed by " when ..." or " for ...", hence the closing comma after a maximum. */
function amountWords(rule: CommissionRule, reward: Reward): string {
  if (rule.calc.type === 'FIXED') return rewardWords(rule.calc.amount, reward);
  const upTo = rule.calc.max != null ? `, up to ${rewardWords(rule.calc.max, reward)},` : '';
  const share = `${rule.calc.percent}% of the ${BASE_LABELS[rule.calc.base]}`;
  return reward.type === 'POINTS' ? `points worth ${share}${upTo}` : `${share}${upTo}`;
}

/** Records a reward the way the program pays it; the rate in force now is kept on the row. */
export function rewardFor(reward: Reward, amount: number): { rewardType: Reward['type']; points: number | null } {
  return reward.type === 'POINTS'
    ? { rewardType: 'POINTS', points: pointsForAmount(amount, reward.pointsPerBirr) }
    : { rewardType: 'MONEY', points: null };
}

function onTimeOnly(rule: CommissionRule): boolean {
  const behaviors = rule.filters.repaymentBehaviors;
  return rule.event === 'LOAN_REPAID' && behaviors.length > 0 && !behaviors.includes('LATE');
}

/** The limits of a rule, e.g. "loans of 1,000 ETB or more", for the bracket after the sentence. */
function limitWords(rule: CommissionRule): string[] {
  const f = rule.filters;
  const notes: string[] = [];
  if (f.minAmount != null) {
    const what = rule.event === 'LOAN_DISBURSED' || rule.event === 'LOAN_REPAID' ? 'loans' : 'orders';
    notes.push(`${what} of ${formatMoney(f.minAmount)} or more`);
  }
  if (f.providerIds.length || f.productIds.length || f.loanKinds.length || f.merchantIds.length || f.categoryIds.length) {
    notes.push('selected products only');
  }
  return notes;
}

function occurrenceWords(rule: CommissionRule): string {
  if (rule.occurrence.mode === 'FIRST') return 'first time only';
  if (rule.occurrence.mode === 'FIRST_N') return `up to ${rule.occurrence.count} times per friend`;
  return 'every time';
}

/** One rule as the person sharing the code reads it. */
export function describeRuleForAffiliate(rule: CommissionRule, reward: Reward = MONEY_REWARD): string {
  const onTime = onTimeOnly(rule) ? ' on time' : '';
  const bracket = [...limitWords(rule), occurrenceWords(rule)].join('; ');
  if (rule.beneficiary === 'AFFILIATE') {
    return `You earn ${amountWords(rule, reward)} when a friend you invited ${FRIEND_DOES[rule.event]}${onTime} (${bracket}).`;
  }
  return `Your friend gets ${amountWords(rule, reward)} when they ${THEY_DO[rule.event]}${onTime} (${bracket}).`;
}

export type CustomerProgramText = {
  /** Short offer for the "get your code" card, from the first rule that pays the affiliate. */
  headline: string | null;
  /** What the invited friend gets, for the share message, from the first welcome-bonus rule. */
  friendOffer: string | null;
  /** When and how earnings are paid, shown under the balance. */
  payoutNote: string;
  /** "How it works" lines. */
  lines: string[];
};

/** Under the balance when no way to use points is switched on yet. */
export const POINTS_USE_NOTE = 'Your points are kept in your points wallet. Ways to use them are coming soon.';

/** The "How it works" line of a points program; what points buy is set separately. */
export const POINTS_WALLET_NOTE = 'Your points are kept in your points wallet on the Earn page, with the ways you can use them.';

export function describeProgramForAffiliate(config: ProgramConfig): CustomerProgramText {
  const reward = config.reward;
  const points = reward.type === 'POINTS';
  const earnings = points ? 'points' : 'earnings';
  const rules = config.commissionRules.filter((r) => r.enabled);
  const lead = rules.find((r) => r.beneficiary === 'AFFILIATE');
  const headline = lead
    ? `Earn ${amountWords(lead, reward)} for each friend who ${FRIEND_DOES[lead.event]}${onTimeOnly(lead) ? ' on time' : ''}.`
    : null;
  const bonus = rules.find((r) => r.beneficiary === 'CUSTOMER');
  const friendOffer = bonus
    ? `You get ${amountWords(bonus, reward)} when you ${THEY_DO[bonus.event]}${onTimeOnly(bonus) ? ' on time' : ''}.`
    : null;
  const scheduled =
    config.payout.schedule === 'WEEKLY' ? 'every week' : config.payout.schedule === 'MONTHLY' ? 'every month' : null;
  const minimum = config.payout.minimumAmount > 0 ? ` once they reach ${formatMoney(config.payout.minimumAmount)}` : '';
  const withdraw = config.withdraw;
  const payoutNote = points
    ? POINTS_WALLET_NOTE
    : withdraw.enabled
      ? `Withdraw your available earnings to your account any time, from ${formatMoney(withdraw.minimum)}.`
      : `Available earnings are paid to your account ${scheduled ?? 'from time to time'}${minimum}.`;

  const lines: string[] = [];
  lines.push(
    config.attribution.newCustomersOnly
      ? 'Share your code with friends who are new to the app. They enter it before their first loan or order.'
      : 'Share your code with friends. They enter it in the app.'
  );
  // Rules that pay the affiliate first, then the friend's welcome bonus.
  for (const rule of [...rules.filter((r) => r.beneficiary === 'AFFILIATE'), ...rules.filter((r) => r.beneficiary !== 'AFFILIATE')]) {
    lines.push(describeRuleForAffiliate(rule, reward));
  }
  if (points && rules.some((r) => r.calc.type === 'PERCENT')) {
    lines.push(`Points are worked out as ${reward.pointsPerBirr} points for every 1 ETB.`);
  }
  if (config.attribution.referralValidDays) {
    lines.push(`Only loans and orders your friend starts within ${config.attribution.referralValidDays} days of entering your code count.`);
  }
  if (config.caps.perReferralTotal != null) lines.push(`You can earn up to ${rewardWords(config.caps.perReferralTotal, reward)} from each friend.`);
  if (config.caps.perAffiliatePerMonth != null) lines.push(`You can earn up to ${rewardWords(config.caps.perAffiliatePerMonth, reward)} a month.`);
  lines.push(
    config.holdDays > 0
      ? `New ${earnings} are on hold for ${config.holdDays} day${config.holdDays === 1 ? '' : 's'}, then become available.`
      : `New ${earnings} become available right away.`
  );
  lines.push(
    `${points ? 'Points' : 'Earnings'} are taken back if the loan is cancelled${config.clawback.onNpl ? ' or your friend stops repaying' : ''}.`
  );
  lines.push(payoutNote);
  if (!points && withdraw.enabled) {
    const limits: string[] = [];
    if (withdraw.maxPerDay != null) limits.push(`${formatMoney(withdraw.maxPerDay)} a day`);
    if (withdraw.maxPerMonth != null) limits.push(`${formatMoney(withdraw.maxPerMonth)} a month`);
    if (limits.length) lines.push(`You can withdraw up to ${limits.join(' and ')}.`);
    if (scheduled) lines.push(`Anything you don't withdraw is paid to your account ${scheduled}${minimum}.`);
  }
  if (!points && config.payout.withholdingTaxPercent > 0) {
    lines.push(`${config.payout.withholdingTaxPercent}% tax is deducted when you are paid.`);
  }
  lines.push(`New ${earnings} can take up to a day to show here.`);
  return { headline, friendOffer, payoutNote, lines };
}
