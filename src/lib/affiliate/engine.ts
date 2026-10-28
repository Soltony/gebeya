/**
 * Pure commission rules engine. Given a program config and the facts of one
 * event (a loan disbursed, a loan repaid, an order delivered or paid), it
 * decides which rules pay whom and how much. No database access, so the
 * daily job and the admin preview run exactly the same logic.
 */
import { addDays, isBefore, isEqual, startOfDay } from 'date-fns';
import {
  formatMoney,
  type Beneficiary,
  type CommissionBase,
  type CommissionEvent,
  type CommissionRule,
  type FundingSource,
  type LoanKind,
  type ProgramConfig,
  type RepaymentBehavior,
} from './config';

export type EventFacts = {
  event: CommissionEvent;
  sourceType: 'LOAN' | 'ORDER';
  sourceId: string;
  eventDate: Date;
  /** When the loan or order started; checked against the referral window. */
  sourceDate: Date;
  loanId: string | null;
  orderId: string | null;
  providerId: string | null;
  productId: string | null;
  loanKind: LoanKind | null;
  merchantId: string | null;
  categoryIds: string[];
  repaymentBehavior: RepaymentBehavior | null;
  principal: number | null;
  serviceFee: number | null;
  feesCollected: number | null;
  orderTotal: number | null;
};

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The loan amount for loan events, the order total for order events. */
export function mainAmount(facts: EventFacts): number | null {
  return facts.sourceType === 'ORDER' ? facts.orderTotal : facts.principal;
}

export function baseValue(base: CommissionBase, facts: EventFacts): number | null {
  switch (base) {
    case 'PRINCIPAL':
      return facts.principal;
    case 'SERVICE_FEE':
      return facts.serviceFee;
    case 'FEES_COLLECTED':
      return facts.feesCollected;
    case 'ORDER_TOTAL':
      return facts.orderTotal;
  }
}

export type MatchResult = { matches: true } | { matches: false; reason: string };

const noMatch = (reason: string): MatchResult => ({ matches: false, reason });

export function matchRule(rule: CommissionRule, facts: EventFacts): MatchResult {
  if (!rule.enabled) return noMatch('Rule is turned off');
  if (rule.event !== facts.event) return noMatch('Rule is for a different event');
  const f = rule.filters;
  if (f.providerIds.length && !(facts.providerId && f.providerIds.includes(facts.providerId))) {
    return noMatch('Provider is not in the rule');
  }
  if (f.productIds.length && !(facts.productId && f.productIds.includes(facts.productId))) {
    return noMatch('Product is not in the rule');
  }
  if (f.loanKinds.length && !(facts.loanKind && f.loanKinds.includes(facts.loanKind))) {
    return noMatch('Loan type is not in the rule');
  }
  if (f.merchantIds.length && !(facts.merchantId && f.merchantIds.includes(facts.merchantId))) {
    return noMatch('Merchant is not in the rule');
  }
  if (f.categoryIds.length && !facts.categoryIds.some((id) => f.categoryIds.includes(id))) {
    return noMatch("No item in the order is in the rule's categories");
  }
  if (
    f.repaymentBehaviors.length &&
    !(facts.repaymentBehavior && f.repaymentBehaviors.includes(facts.repaymentBehavior))
  ) {
    return noMatch('Repayment timing does not match');
  }
  if (f.minAmount != null) {
    const amount = mainAmount(facts);
    if (amount == null || amount < f.minAmount) return noMatch(`Amount is below ${formatMoney(f.minAmount)}`);
  }
  return { matches: true };
}

/**
 * Commission for one matched rule, before caps. A percentage rule pays nothing
 * when its base is 0 (for example no fees were collected); min and max only
 * bound a positive amount.
 */
export function calculateRuleAmount(rule: CommissionRule, facts: EventFacts): { baseAmount: number; amount: number } {
  if (rule.calc.type === 'FIXED') {
    return { baseAmount: roundMoney(mainAmount(facts) ?? 0), amount: roundMoney(rule.calc.amount) };
  }
  const base = Math.max(0, baseValue(rule.calc.base, facts) ?? 0);
  if (base <= 0) return { baseAmount: 0, amount: 0 };
  let amount = (base * rule.calc.percent) / 100;
  if (rule.calc.min != null) amount = Math.max(amount, rule.calc.min);
  if (rule.calc.max != null) amount = Math.min(amount, rule.calc.max);
  return { baseAmount: roundMoney(base), amount: roundMoney(Math.max(0, amount)) };
}

export function occurrenceAllows(rule: CommissionRule, priorCount: number): boolean {
  if (rule.occurrence.mode === 'EVERY') return true;
  if (rule.occurrence.mode === 'FIRST') return priorCount < 1;
  return priorCount < (rule.occurrence.count ?? 1);
}

export type CapRoom = { label: string; remaining: number | null };

/** Lowers an amount to the smallest remaining cap; null caps are ignored. */
export function applyCaps(amount: number, rooms: CapRoom[]): { amount: number; cappedBy: string | null } {
  let result = amount;
  let cappedBy: string | null = null;
  for (const room of rooms) {
    if (room.remaining == null) continue;
    const available = Math.max(0, roundMoney(room.remaining));
    if (result > available) {
      result = available;
      cappedBy = room.label;
    }
  }
  return { amount: roundMoney(result), cappedBy };
}

/** Whether a loan/order that started on sourceDate counts for a referral made at attributedAt. */
export function isWithinReferralWindow(config: ProgramConfig, attributedAt: Date, sourceDate: Date): boolean {
  if (sourceDate.getTime() < attributedAt.getTime()) return false;
  const days = config.attribution.referralValidDays;
  if (!days) return true;
  return sourceDate.getTime() <= addDays(attributedAt, days).getTime();
}

export type PauseWindow = { from: Date; to: Date };

export function parsePausedPeriods(json: string | null | undefined): PauseWindow[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((p) => ({ from: new Date(p?.from), to: new Date(p?.to) }))
      .filter((p) => !isNaN(p.from.getTime()) && !isNaN(p.to.getTime()));
  } catch {
    return [];
  }
}

/** Events that happen while a program is paused never earn. */
export function isDuringPause(date: Date, pausedAt: Date | null, periods: PauseWindow[]): boolean {
  const t = date.getTime();
  if (pausedAt && t >= pausedAt.getTime()) return true;
  return periods.some((p) => t >= p.from.getTime() && t <= p.to.getTime());
}

export function holdUntilFor(config: ProgramConfig, eventDate: Date): Date {
  return addDays(eventDate, config.holdDays);
}

/** Same day-level comparison the repayment pipeline uses to set repaymentBehavior. */
export function deriveRepaymentBehavior(lastPaymentDate: Date, dueDate: Date): RepaymentBehavior {
  const paid = startOfDay(lastPaymentDate);
  const due = startOfDay(dueDate);
  if (isBefore(paid, due)) return 'EARLY';
  if (isEqual(paid, due)) return 'ON_TIME';
  return 'LATE';
}

export type LineStatus = 'PAYS' | 'NOT_MATCHED' | 'LIMIT_REACHED' | 'ZERO' | 'CAPPED_OUT' | 'ALREADY_RECORDED';

export type EvaluatedLine = {
  rule: CommissionRule;
  beneficiary: Beneficiary;
  fundedBy: FundingSource;
  status: LineStatus;
  reason: string | null;
  baseAmount: number;
  /** Amount before caps. */
  calculatedAmount: number;
  /** Amount to pay after caps; 0 unless status is PAYS. */
  amount: number;
  cappedBy: string | null;
};

export type CapRooms = {
  /** What the affiliate can still earn from this referred customer. */
  perReferral: number | null;
  /** What the affiliate can still earn in the event's month. */
  perAffiliateMonth: number | null;
  /** What the whole program can still spend. */
  budget: number | null;
};

export type EvaluationContext = {
  /** Commissions this referral already earned under the rule, for earlier events. */
  priorCount: (ruleId: string, beneficiary: Beneficiary) => number;
  /** Whether this exact event already has a commission for the rule. */
  isRecorded?: (ruleId: string, beneficiary: Beneficiary) => boolean;
  rooms: CapRooms;
};

/**
 * Runs every rule of a program against one event. Rules are applied in order
 * and caps are consumed as they go, so two rules can't overshoot a cap
 * together. The context is not modified; the caller subtracts the granted
 * amounts from its own cap tracking.
 */
export function evaluateEvent(config: ProgramConfig, facts: EventFacts, ctx: EvaluationContext): EvaluatedLine[] {
  const rooms: CapRooms = { ...ctx.rooms };
  const lines: EvaluatedLine[] = [];

  for (const rule of config.commissionRules) {
    const line: EvaluatedLine = {
      rule,
      beneficiary: rule.beneficiary,
      fundedBy: rule.fundedBy,
      status: 'PAYS',
      reason: null,
      baseAmount: 0,
      calculatedAmount: 0,
      amount: 0,
      cappedBy: null,
    };

    const match = matchRule(rule, facts);
    if (!match.matches) {
      lines.push({ ...line, status: 'NOT_MATCHED', reason: match.reason });
      continue;
    }
    if (ctx.isRecorded?.(rule.id, rule.beneficiary)) {
      lines.push({ ...line, status: 'ALREADY_RECORDED', reason: 'Already recorded for this event' });
      continue;
    }
    if (!occurrenceAllows(rule, ctx.priorCount(rule.id, rule.beneficiary))) {
      const limit = rule.occurrence.mode === 'FIRST' ? 'once' : `${rule.occurrence.count} times`;
      lines.push({ ...line, status: 'LIMIT_REACHED', reason: `Already paid ${limit} for this customer` });
      continue;
    }

    const { baseAmount, amount } = calculateRuleAmount(rule, facts);
    if (amount <= 0) {
      lines.push({ ...line, status: 'ZERO', reason: 'Nothing to pay (amount is 0)', baseAmount });
      continue;
    }

    const capList: CapRoom[] =
      rule.beneficiary === 'AFFILIATE'
        ? [
            { label: 'Max per referred customer', remaining: rooms.perReferral },
            { label: 'Max per affiliate per month', remaining: rooms.perAffiliateMonth },
            { label: 'Program budget', remaining: rooms.budget },
          ]
        : [{ label: 'Program budget', remaining: rooms.budget }];
    const capped = applyCaps(amount, capList);
    if (capped.amount <= 0) {
      lines.push({
        ...line,
        status: 'CAPPED_OUT',
        reason: `${capped.cappedBy} reached`,
        baseAmount,
        calculatedAmount: amount,
        cappedBy: capped.cappedBy,
      });
      continue;
    }

    if (rule.beneficiary === 'AFFILIATE') {
      if (rooms.perReferral != null) rooms.perReferral = roundMoney(rooms.perReferral - capped.amount);
      if (rooms.perAffiliateMonth != null) rooms.perAffiliateMonth = roundMoney(rooms.perAffiliateMonth - capped.amount);
    }
    if (rooms.budget != null) rooms.budget = roundMoney(rooms.budget - capped.amount);

    lines.push({
      ...line,
      baseAmount,
      calculatedAmount: amount,
      amount: capped.amount,
      cappedBy: capped.cappedBy,
    });
  }

  return lines;
}

/** Remaining room for a cap given what was already used; null when there is no cap. */
export function remainingRoom(cap: number | null, used: number): number | null {
  return cap == null ? null : roundMoney(Math.max(0, cap - used));
}
