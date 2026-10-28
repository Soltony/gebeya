import { describe, expect, test } from 'vitest';
import {
  PROGRAM_TEMPLATES,
  BLANK_CONFIG,
  describeRule,
  normalizeReferralCode,
  parseProgramConfig,
  programConfigSchema,
  type CommissionRuleInput,
  type ProgramConfig,
  type ProgramConfigInput,
} from './config';
import {
  applyCaps,
  calculateRuleAmount,
  deriveRepaymentBehavior,
  evaluateEvent,
  isDuringPause,
  isWithinReferralWindow,
  matchRule,
  occurrenceAllows,
  parsePausedPeriods,
  type EventFacts,
} from './engine';

function config(overrides: Partial<ProgramConfigInput> = {}): ProgramConfig {
  return programConfigSchema.parse({ ...BLANK_CONFIG, ...overrides });
}

function rule(overrides: Partial<CommissionRuleInput> = {}): CommissionRuleInput {
  return {
    id: 'r1',
    name: 'Rule',
    enabled: true,
    event: 'LOAN_REPAID',
    beneficiary: 'AFFILIATE',
    fundedBy: 'PLATFORM',
    calc: { type: 'FIXED', amount: 100 },
    occurrence: { mode: 'EVERY', count: null },
    filters: {},
    ...overrides,
  };
}

function loanFacts(overrides: Partial<EventFacts> = {}): EventFacts {
  return {
    event: 'LOAN_REPAID',
    sourceType: 'LOAN',
    sourceId: 'loan-1',
    eventDate: new Date('2026-10-10T10:00:00Z'),
    sourceDate: new Date('2026-10-01T10:00:00Z'),
    loanId: 'loan-1',
    orderId: null,
    providerId: 'prov-1',
    productId: 'prod-1',
    loanKind: 'PERSONAL',
    merchantId: null,
    categoryIds: [],
    repaymentBehavior: 'ON_TIME',
    principal: 5000,
    serviceFee: 150,
    feesCollected: 400,
    orderTotal: null,
    ...overrides,
  };
}

const noHistory = { priorCount: () => 0, rooms: { perReferral: null, perAffiliateMonth: null, budget: null } };

describe('program config validation', () => {
  test('every template is a valid program', () => {
    for (const template of PROGRAM_TEMPLATES) {
      const result = parseProgramConfig(template.config);
      expect(result.success, template.key).toBe(true);
    }
    expect(parseProgramConfig(BLANK_CONFIG).success).toBe(true);
  });

  test('fills defaults for omitted sections', () => {
    const parsed = config({ commissionRules: [rule()] });
    expect(parsed.commissionRules[0].filters.productIds).toEqual([]);
    expect(parsed.payout.withholdingTaxPercent).toBe(0);
  });

  test('rejects a percentage base that does not fit the event', () => {
    const result = parseProgramConfig({
      ...BLANK_CONFIG,
      commissionRules: [rule({ event: 'DIRECT_ORDER_PAID', calc: { type: 'PERCENT', percent: 2, base: 'PRINCIPAL' } })],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors[0]).toContain('Rule 1');
  });

  test('requires a count for "first N times"', () => {
    const result = parseProgramConfig({
      ...BLANK_CONFIG,
      commissionRules: [rule({ occurrence: { mode: 'FIRST_N', count: null } })],
    });
    expect(result.success).toBe(false);
  });

  test('rejects filters that do not apply to the event', () => {
    const result = parseProgramConfig({
      ...BLANK_CONFIG,
      commissionRules: [rule({ event: 'DIRECT_ORDER_PAID', filters: { productIds: ['prod-1'] } })],
    });
    expect(result.success).toBe(false);
  });

  test('rejects duplicate rule ids and programs with every rule turned off', () => {
    expect(parseProgramConfig({ ...BLANK_CONFIG, commissionRules: [rule(), rule()] }).success).toBe(false);
    expect(parseProgramConfig({ ...BLANK_CONFIG, commissionRules: [rule({ enabled: false })] }).success).toBe(false);
  });

  test('rejects a minimum above the maximum', () => {
    const result = parseProgramConfig({
      ...BLANK_CONFIG,
      commissionRules: [rule({ calc: { type: 'PERCENT', percent: 2, base: 'PRINCIPAL', min: 50, max: 10 } })],
    });
    expect(result.success).toBe(false);
  });
});

describe('calculateRuleAmount', () => {
  test('fixed amount', () => {
    const r = config({ commissionRules: [rule()] }).commissionRules[0];
    expect(calculateRuleAmount(r, loanFacts()).amount).toBe(100);
  });

  test('percentage bounded by min and max', () => {
    const pct = (min: number | null, max: number | null) =>
      config({ commissionRules: [rule({ calc: { type: 'PERCENT', percent: 10, base: 'FEES_COLLECTED', min, max } })] })
        .commissionRules[0];
    expect(calculateRuleAmount(pct(null, null), loanFacts()).amount).toBe(40);
    expect(calculateRuleAmount(pct(null, 25), loanFacts()).amount).toBe(25);
    expect(calculateRuleAmount(pct(60, null), loanFacts()).amount).toBe(60);
  });

  test('pays nothing when the base is 0, even with a minimum', () => {
    const r = config({
      commissionRules: [rule({ calc: { type: 'PERCENT', percent: 10, base: 'FEES_COLLECTED', min: 60, max: null } })],
    }).commissionRules[0];
    expect(calculateRuleAmount(r, loanFacts({ feesCollected: 0 })).amount).toBe(0);
  });

  test('rounds to cents', () => {
    const r = config({
      commissionRules: [rule({ calc: { type: 'PERCENT', percent: 3.333, base: 'PRINCIPAL' } })],
    }).commissionRules[0];
    expect(calculateRuleAmount(r, loanFacts({ principal: 1000 })).amount).toBe(33.33);
  });
});

describe('matchRule', () => {
  const build = (overrides: Partial<CommissionRuleInput>) => config({ commissionRules: [rule(overrides)] }).commissionRules[0];

  test('product, provider and loan type filters', () => {
    expect(matchRule(build({ filters: { productIds: ['prod-1'] } }), loanFacts()).matches).toBe(true);
    expect(matchRule(build({ filters: { productIds: ['prod-2'] } }), loanFacts()).matches).toBe(false);
    expect(matchRule(build({ filters: { providerIds: ['prov-2'] } }), loanFacts()).matches).toBe(false);
    expect(matchRule(build({ filters: { loanKinds: ['BNPL'] } }), loanFacts()).matches).toBe(false);
  });

  test('repayment timing filter', () => {
    const onTime = build({ filters: { repaymentBehaviors: ['EARLY', 'ON_TIME'] } });
    expect(matchRule(onTime, loanFacts({ repaymentBehavior: 'ON_TIME' })).matches).toBe(true);
    expect(matchRule(onTime, loanFacts({ repaymentBehavior: 'LATE' })).matches).toBe(false);
  });

  test('minimum amount uses the loan amount or the order total', () => {
    expect(matchRule(build({ filters: { minAmount: 6000 } }), loanFacts()).matches).toBe(false);
    const order = build({ event: 'DIRECT_ORDER_PAID', filters: { minAmount: 1000 } });
    const orderFacts = loanFacts({ event: 'DIRECT_ORDER_PAID', sourceType: 'ORDER', orderTotal: 1500, principal: null });
    expect(matchRule(order, orderFacts).matches).toBe(true);
  });

  test('category filter matches when any item is in the category', () => {
    const r = build({ event: 'BNPL_ORDER_DELIVERED', calc: { type: 'FIXED', amount: 10 }, filters: { categoryIds: ['phones'] } });
    const facts = loanFacts({ event: 'BNPL_ORDER_DELIVERED', sourceType: 'ORDER', categoryIds: ['tv', 'phones'], orderTotal: 900 });
    expect(matchRule(r, facts).matches).toBe(true);
    expect(matchRule(r, { ...facts, categoryIds: ['tv'] }).matches).toBe(false);
  });

  test('turned-off rules and other events never match', () => {
    const c = config({ commissionRules: [rule({ id: 'a' }), rule({ id: 'b', enabled: false })] });
    expect(matchRule(c.commissionRules[1], loanFacts()).matches).toBe(false);
    expect(matchRule(c.commissionRules[0], loanFacts({ event: 'LOAN_DISBURSED' })).matches).toBe(false);
  });
});

describe('occurrence', () => {
  const build = (occurrence: CommissionRuleInput['occurrence']) =>
    config({ commissionRules: [rule({ occurrence })] }).commissionRules[0];

  test('first, first N and every', () => {
    expect(occurrenceAllows(build({ mode: 'FIRST', count: null }), 0)).toBe(true);
    expect(occurrenceAllows(build({ mode: 'FIRST', count: null }), 1)).toBe(false);
    expect(occurrenceAllows(build({ mode: 'FIRST_N', count: 3 }), 2)).toBe(true);
    expect(occurrenceAllows(build({ mode: 'FIRST_N', count: 3 }), 3)).toBe(false);
    expect(occurrenceAllows(build({ mode: 'EVERY', count: null }), 99)).toBe(true);
  });
});

describe('evaluateEvent', () => {
  const twoSided = config({
    commissionRules: [
      rule({ id: 'referrer', calc: { type: 'FIXED', amount: 50 }, occurrence: { mode: 'FIRST', count: null } }),
      rule({ id: 'welcome', beneficiary: 'CUSTOMER', calc: { type: 'FIXED', amount: 20 }, occurrence: { mode: 'FIRST', count: null } }),
    ],
  });

  test('pays both the affiliate and the new customer', () => {
    const lines = evaluateEvent(twoSided, loanFacts(), noHistory);
    expect(lines.map((l) => [l.rule.id, l.status, l.amount])).toEqual([
      ['referrer', 'PAYS', 50],
      ['welcome', 'PAYS', 20],
    ]);
  });

  test('a rule that already paid once does not pay again', () => {
    const lines = evaluateEvent(twoSided, loanFacts(), {
      ...noHistory,
      priorCount: (ruleId) => (ruleId === 'referrer' ? 1 : 0),
    });
    expect(lines[0].status).toBe('LIMIT_REACHED');
    expect(lines[1].status).toBe('PAYS');
  });

  test('skips rules already recorded for the same event', () => {
    const lines = evaluateEvent(twoSided, loanFacts(), { ...noHistory, isRecorded: (ruleId) => ruleId === 'welcome' });
    expect(lines[1].status).toBe('ALREADY_RECORDED');
  });

  test('caps are shared across the rules of one event', () => {
    const c = config({
      commissionRules: [
        rule({ id: 'a', calc: { type: 'FIXED', amount: 80 } }),
        rule({ id: 'b', calc: { type: 'FIXED', amount: 80 } }),
      ],
    });
    const lines = evaluateEvent(c, loanFacts(), {
      priorCount: () => 0,
      rooms: { perReferral: 100, perAffiliateMonth: null, budget: null },
    });
    expect(lines.map((l) => l.amount)).toEqual([80, 20]);
    expect(lines[1].cappedBy).toBe('Max per referred customer');
  });

  test('a customer bonus only counts against the program budget', () => {
    const lines = evaluateEvent(twoSided, loanFacts(), {
      priorCount: () => 0,
      rooms: { perReferral: 0, perAffiliateMonth: 0, budget: 15 },
    });
    expect(lines[0].status).toBe('CAPPED_OUT');
    expect(lines[1].amount).toBe(15);
  });

  test('does not change the caller context', () => {
    const rooms = { perReferral: 100, perAffiliateMonth: 100, budget: 100 };
    evaluateEvent(twoSided, loanFacts(), { priorCount: () => 0, rooms });
    expect(rooms).toEqual({ perReferral: 100, perAffiliateMonth: 100, budget: 100 });
  });
});

describe('referral window, pauses and caps', () => {
  test('only loans started after the referral and inside the window count', () => {
    const c = config({ attribution: { referralValidDays: 30 } });
    const referredAt = new Date('2026-10-01T00:00:00Z');
    expect(isWithinReferralWindow(c, referredAt, new Date('2026-09-30T00:00:00Z'))).toBe(false);
    expect(isWithinReferralWindow(c, referredAt, new Date('2026-10-20T00:00:00Z'))).toBe(true);
    expect(isWithinReferralWindow(c, referredAt, new Date('2026-11-15T00:00:00Z'))).toBe(false);
    expect(isWithinReferralWindow(config(), referredAt, new Date('2030-01-01T00:00:00Z'))).toBe(true);
  });

  test('events inside a pause never earn', () => {
    const periods = parsePausedPeriods(JSON.stringify([{ from: '2026-10-05T00:00:00Z', to: '2026-10-07T00:00:00Z' }]));
    expect(isDuringPause(new Date('2026-10-06T00:00:00Z'), null, periods)).toBe(true);
    expect(isDuringPause(new Date('2026-10-08T00:00:00Z'), null, periods)).toBe(false);
    expect(isDuringPause(new Date('2026-10-20T00:00:00Z'), new Date('2026-10-15T00:00:00Z'), periods)).toBe(true);
    expect(parsePausedPeriods('not json')).toEqual([]);
  });

  test('applyCaps lowers to the tightest cap', () => {
    expect(applyCaps(100, [{ label: 'A', remaining: 70 }, { label: 'B', remaining: 40 }])).toEqual({ amount: 40, cappedBy: 'B' });
    expect(applyCaps(100, [{ label: 'A', remaining: null }])).toEqual({ amount: 100, cappedBy: null });
  });

  test('repayment timing is derived from the last payment and the due date', () => {
    const due = new Date(2026, 9, 10, 0, 0);
    expect(deriveRepaymentBehavior(new Date(2026, 9, 9, 18, 0), due)).toBe('EARLY');
    expect(deriveRepaymentBehavior(new Date(2026, 9, 10, 18, 0), due)).toBe('ON_TIME');
    expect(deriveRepaymentBehavior(new Date(2026, 9, 11, 8, 0), due)).toBe('LATE');
  });
});

describe('helpers', () => {
  test('describeRule reads as a sentence', () => {
    const r = config({
      commissionRules: [rule({ filters: { repaymentBehaviors: ['ON_TIME'] }, occurrence: { mode: 'FIRST', count: null } })],
    }).commissionRules[0];
    expect(describeRule(r)).toBe(
      "When a referred customer's loan is fully repaid (on time), pay the affiliate 100 ETB, first time only. Paid by the platform."
    );
  });

  test('normalizeReferralCode', () => {
    expect(normalizeReferralCode(' ab-12 cd ')).toBe('AB12CD');
  });
});
