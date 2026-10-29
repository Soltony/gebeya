import { describe, expect, test } from 'vitest';
import {
  BLANK_CONFIG,
  DEFAULT_POINTS_SETTINGS,
  PROGRAM_TEMPLATES,
  birrPerPoint,
  formatPoints,
  parseProgramConfig,
  pointsForAmount,
  pointsSettingsSchema,
  programConfigSchema,
  type ProgramConfig,
} from './config';
import {
  POINTS_WALLET_NOTE,
  birrForPoints,
  checkSelfJoinEligibility,
  pointsNeeded,
  pointsUseProblem,
  rewardFor,
  customCodeProblem,
  describeProgramForAffiliate,
  describeRuleForAffiliate,
  earningState,
  paymentState,
  selectForWithdrawal,
  shortPersonName,
  summarizeBalances,
  toTitleCase,
  withdrawalBlockedReason,
  withdrawalCap,
} from './earn-rules';

const referAFriend = programConfigSchema.parse(PROGRAM_TEMPLATES.find((t) => t.key === 'REFER_A_FRIEND')!.config);
const settings = referAFriend.selfJoin;

describe('selfJoin settings', () => {
  test('older stored programs without the section read as sign-up off', () => {
    const { selfJoin, ...withoutSection } = programConfigSchema.parse(BLANK_CONFIG);
    void selfJoin;
    const parsed = parseProgramConfig(withoutSection);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.config.selfJoin).toEqual({ enabled: false, minRepaidLoans: 1, blockIfOverdue: true, allowCustomCode: true });
    }
  });

  test('sign-up needs Borrower among the affiliate types', () => {
    const agentsOnly = { ...programConfigSchema.parse(BLANK_CONFIG), selfJoin: { ...settings, enabled: true } };
    const parsed = parseProgramConfig(agentsOnly);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.errors[0]).toContain('Customer sign-up');
    expect(parseProgramConfig({ ...agentsOnly, allowedAffiliateTypes: ['AGENT', 'BORROWER'] }).success).toBe(true);
  });

  test('the Refer a Friend template turns sign-up on', () => {
    expect(referAFriend.selfJoin.enabled).toBe(true);
  });
});

describe('checkSelfJoinEligibility', () => {
  test('a customer with a repaid loan and nothing overdue can join', () => {
    expect(checkSelfJoinEligibility(settings, { repaidLoans: 1, hasOverdue: false, isNpl: false })).toEqual({
      eligible: true,
      reasons: [],
    });
  });

  test('explains every missing condition', () => {
    const check = checkSelfJoinEligibility(settings, { repaidLoans: 0, hasOverdue: true, isNpl: false });
    expect(check.eligible).toBe(false);
    expect(check.reasons).toEqual([
      'You have an overdue payment. Pay it to get your code.',
      'Fully repay your first loan to get your code.',
    ]);
  });

  test('overdue payments only block when the program says so, NPL always blocks', () => {
    const lenient = { ...settings, blockIfOverdue: false, minRepaidLoans: 0 };
    expect(checkSelfJoinEligibility(lenient, { repaidLoans: 0, hasOverdue: true, isNpl: false }).eligible).toBe(true);
    expect(checkSelfJoinEligibility(lenient, { repaidLoans: 0, hasOverdue: true, isNpl: true }).eligible).toBe(false);
  });

  test('counts the repaid loans still needed', () => {
    const check = checkSelfJoinEligibility({ ...settings, minRepaidLoans: 3 }, { repaidLoans: 1, hasOverdue: false, isNpl: false });
    expect(check.reasons).toEqual(['Fully repay 3 loans to get your code (you have repaid 1).']);
  });
});

describe('customCodeProblem', () => {
  test('accepts 4 to 12 letters and digits', () => {
    expect(customCodeProblem('ABEBE2026')).toBeNull();
    expect(customCodeProblem('ABCD')).toBeNull();
  });

  test('rejects the wrong length or characters', () => {
    expect(customCodeProblem('ABC')).not.toBeNull();
    expect(customCodeProblem('ABCDEFGHIJKLM')).not.toBeNull();
    expect(customCodeProblem('ABE-BE')).not.toBeNull();
  });

  test('needs at least one letter so a code never looks like a phone or account number', () => {
    expect(customCodeProblem('20262026')).toBe('Include at least one letter.');
  });

  test('blocks words that could pass for the bank', () => {
    expect(customCodeProblem('NIBPROMO')).toBe('This code is reserved. Please choose another one.');
    expect(customCodeProblem('MYBANK1')).toBe('This code is reserved. Please choose another one.');
    expect(customCodeProblem('ADMIN1')).not.toBeNull();
  });
});

describe('names', () => {
  test('title-cases names from the bank', () => {
    expect(toTitleCase('  ABEBE  KEBEDE alemu ')).toBe('Abebe Kebede Alemu');
  });

  test('friends see the first name and an initial', () => {
    expect(shortPersonName('Abebe Kebede Alemu')).toBe('Abebe K.');
    expect(shortPersonName('Abebe')).toBe('Abebe');
  });
});

describe('balances', () => {
  test('adds up each status; take-backs lower what is available', () => {
    expect(
      summarizeBalances([
        { status: 'PAYABLE', amount: 150 },
        { status: 'PAYABLE', amount: -50 },
        { status: 'PENDING', amount: 20.005 },
        { status: 'IN_PAYOUT', amount: 30 },
        { status: 'PAID', amount: 500 },
        { status: 'REVERSED', amount: 70 },
      ])
    ).toEqual({ available: 100, onHold: 20.01, beingPaid: 30 });
  });

  test('a take-back after payment leaves a negative balance', () => {
    expect(summarizeBalances([{ status: 'PAYABLE', amount: -50 }]).available).toBe(-50);
  });

  test('maps commission and payout statuses to what the customer reads', () => {
    expect(earningState('EARNED', 'PENDING')).toBe('ON_HOLD');
    expect(earningState('EARNED', 'PAYABLE')).toBe('AVAILABLE');
    expect(earningState('EARNED', 'REVERSED')).toBe('CANCELLED');
    expect(earningState('CLAWBACK', 'PAYABLE')).toBe('TAKEN_BACK');
  });

  test('payouts read differently for admin batches and own withdrawals', () => {
    const batch = { status: 'PENDING_APPROVAL', source: 'MANUAL' };
    const withdrawal = { status: 'PENDING_APPROVAL', source: 'SELF_SERVICE' };
    expect(paymentState('SUCCESS', batch)).toBe('PAID');
    expect(paymentState('FAILED', batch)).toBe('DELAYED');
    expect(paymentState('PENDING_APPROVAL', batch)).toBe('PROCESSING');
    expect(paymentState('PENDING_APPROVAL', withdrawal)).toBe('IN_REVIEW');
    expect(paymentState('CANCELLED', batch)).toBeNull();
    expect(paymentState('CANCELLED', { status: 'REJECTED', source: 'SELF_SERVICE' })).toBe('DECLINED');
    expect(paymentState('CANCELLED', { status: 'CANCELLED', source: 'SELF_SERVICE' })).toBe('RETURNED');
  });
});

describe('points', () => {
  test('older stored programs read as money; new programs default to points', () => {
    const { reward, ...withoutSection } = programConfigSchema.parse(BLANK_CONFIG);
    expect(reward).toEqual({ type: 'POINTS', pointsPerBirr: 10 });
    const parsed = parseProgramConfig(withoutSection);
    expect(parsed.success && parsed.config.reward).toEqual({ type: 'MONEY', pointsPerBirr: 10 });
  });

  test('the earning rate must be above zero', () => {
    const base = programConfigSchema.parse(BLANK_CONFIG);
    expect(parseProgramConfig({ ...base, reward: { type: 'POINTS', pointsPerBirr: 0 } }).success).toBe(false);
    expect(parseProgramConfig({ ...base, reward: { type: 'POINTS', pointsPerBirr: 2.5 } }).success).toBe(true);
  });

  test('a reward is recorded as money, or as whole points at the rate in force', () => {
    expect(rewardFor({ type: 'MONEY', pointsPerBirr: 10 }, 50)).toEqual({ rewardType: 'MONEY', points: null });
    expect(rewardFor({ type: 'POINTS', pointsPerBirr: 10 }, 50)).toEqual({ rewardType: 'POINTS', points: 500 });
    expect(rewardFor({ type: 'POINTS', pointsPerBirr: 2.5 }, 4.9)).toEqual({ rewardType: 'POINTS', points: 12 });
    expect(pointsForAmount(0.04, 10)).toBe(0);
  });

  test('credited points read as added', () => {
    expect(earningState('EARNED', 'CREDITED')).toBe('CREDITED');
    expect(earningState('CLAWBACK', 'CREDITED')).toBe('TAKEN_BACK');
  });

  test('points settings: a point needs a value above zero', () => {
    expect(pointsSettingsSchema.parse({}).pointValue).toBe(0.1);
    expect(pointsSettingsSchema.safeParse({ pointValue: 0 }).success).toBe(false);
    expect(formatPoints(1)).toBe('1 point');
    expect(formatPoints(-2450)).toBe('-2,450 points');
  });
});

describe('using points', () => {
  test('points and Birr convert at the rate of the use, never paying short', () => {
    expect(birrForPoints(300, 0.08)).toBe(24);
    expect(birrForPoints(3, 0.1)).toBe(0.3);
    expect(pointsNeeded(245, 0.1)).toBe(2450);
    expect(pointsNeeded(245.05, 0.1)).toBe(2451);
    expect(pointsNeeded(5, 0.3)).toBe(17);
  });

  test('each use can have its own rate, or follow the point value', () => {
    const settings = pointsSettingsSchema.parse({ pointValue: 0.1, withdrawal: { birrPerPoint: 0.08 } });
    expect(birrPerPoint(settings, 'withdrawal')).toBe(0.08);
    expect(birrPerPoint(settings, 'shop')).toBe(0.1);
  });

  test('uses start switched off', () => {
    expect(DEFAULT_POINTS_SETTINGS.shop.enabled).toBe(false);
    expect(DEFAULT_POINTS_SETTINGS.repayment.enabled).toBe(false);
    expect(DEFAULT_POINTS_SETTINGS.withdrawal.enabled).toBe(false);
  });

  test('checks: on, minimum, balance, daily and monthly limits', () => {
    const use = { enabled: true, birrPerPoint: null, minPoints: 100, maxPointsPerDay: 1000, maxPointsPerMonth: 3000 };
    const fine = { points: 500, balance: 2000, usedToday: 0, usedThisMonth: 0 };
    expect(pointsUseProblem(use, fine)).toBeNull();
    expect(pointsUseProblem({ ...use, enabled: false }, fine)).toBe('This is not available right now.');
    expect(pointsUseProblem(use, { ...fine, points: 50 })).toBe('Use at least 100 points.');
    expect(pointsUseProblem(use, { ...fine, points: 2500 })).toBe('You only have 2,000 points.');
    expect(pointsUseProblem(use, { ...fine, usedToday: 800 })).toBe('You can use up to 200 points more today.');
    expect(pointsUseProblem(use, { ...fine, usedToday: 1000 })).toBe("You reached today's limit. Please try again tomorrow.");
    expect(pointsUseProblem(use, { ...fine, usedThisMonth: 2800 })).toBe('You can use up to 200 points more this month.');
    expect(pointsUseProblem(use, { ...fine, points: 12.5 })).toBe('Enter a whole number of points.');
  });

  test('settings: daily max at least the minimum, monthly at least the daily', () => {
    expect(pointsSettingsSchema.safeParse({ shop: { minPoints: 100, maxPointsPerDay: 50 } }).success).toBe(false);
    expect(pointsSettingsSchema.safeParse({ shop: { maxPointsPerDay: 1000, maxPointsPerMonth: 500 } }).success).toBe(false);
    expect(pointsSettingsSchema.safeParse({ shop: { maxPointsPerDay: 1000, maxPointsPerMonth: 5000 } }).success).toBe(true);
    expect(pointsSettingsSchema.safeParse({ withdrawal: { birrPerPoint: 0 } }).success).toBe(false);
  });
});

describe('withdrawals', () => {
  const day = (d: number) => new Date(2026, 9, d);

  test('limits: the smaller of what is left today and this month', () => {
    const limits = { enabled: true, minimum: 50, maxPerDay: 500, maxPerMonth: 2000, autoApproveUpTo: 500 };
    expect(withdrawalCap(limits, { today: 100, month: 1900 })).toBe(100);
    expect(withdrawalCap(limits, { today: 450, month: 600 })).toBe(50);
    expect(withdrawalCap(limits, { today: 600, month: 600 })).toBe(0);
    expect(withdrawalCap({ ...limits, maxPerDay: null, maxPerMonth: null }, { today: 9999, month: 9999 })).toBeNull();
  });

  test('takes every take-back, then the oldest earnings that fit', () => {
    const rows = [
      { id: 'new', amount: 300, eventDate: day(5) },
      { id: 'old', amount: 200, eventDate: day(1) },
      { id: 'back', amount: -50, eventDate: day(6) },
      { id: 'mid', amount: 100, eventDate: day(3) },
    ];
    const all = selectForWithdrawal(rows, null);
    expect(all.total).toBe(550);
    expect(all.rows.map((r) => r.id)).toEqual(['back', 'old', 'mid', 'new']);

    const capped = selectForWithdrawal(rows, 300);
    expect(capped.rows.map((r) => r.id)).toEqual(['back', 'old', 'mid']);
    expect(capped.total).toBe(250);
  });

  test('skips an earning bigger than the room left, but still fits smaller ones', () => {
    const rows = [
      { id: 'big', amount: 600, eventDate: day(1) },
      { id: 'small', amount: 40, eventDate: day(2) },
    ];
    expect(selectForWithdrawal(rows, 500).rows.map((r) => r.id)).toEqual(['small']);
  });

  test('explains why nothing can be withdrawn now', () => {
    const limits = { enabled: true, minimum: 50, maxPerDay: 500, maxPerMonth: 2000, autoApproveUpTo: 500 };
    const fresh = { today: 0, month: 0 };
    expect(withdrawalBlockedReason(limits, fresh, [{ amount: 30 }])).toBe('You can withdraw from 50 ETB.');
    expect(withdrawalBlockedReason(limits, { today: 120, month: 120 }, [{ amount: 450 }, { amount: 30 }])).toBe(
      "You can't withdraw more today. Please try again tomorrow."
    );
    expect(withdrawalBlockedReason(limits, { today: 0, month: 1900 }, [{ amount: 450 }])).toBe("You can't withdraw more this month.");
    expect(withdrawalBlockedReason(limits, fresh, [{ amount: 700 }])).toBe(
      'One of your earnings is above the withdrawal limit, so it is paid to you in a regular payout.'
    );
  });

  test('settings: daily maximum at least the minimum, monthly at least the daily', () => {
    const base = programConfigSchema.parse(BLANK_CONFIG);
    const withdraw = { enabled: true, minimum: 100, maxPerDay: 50, maxPerMonth: null, autoApproveUpTo: 0 };
    const tooLowDaily = parseProgramConfig({ ...base, withdraw });
    expect(tooLowDaily.success).toBe(false);
    if (!tooLowDaily.success) expect(tooLowDaily.errors[0]).toContain('Withdrawals › Max per day');
    expect(parseProgramConfig({ ...base, withdraw: { ...withdraw, maxPerDay: 500, maxPerMonth: 400 } }).success).toBe(false);
    expect(parseProgramConfig({ ...base, withdraw: { ...withdraw, maxPerDay: 500, maxPerMonth: 5000 } }).success).toBe(true);
  });

  test('older stored programs read as withdrawals off', () => {
    const { withdraw, ...withoutSection } = programConfigSchema.parse(BLANK_CONFIG);
    void withdraw;
    const parsed = parseProgramConfig(withoutSection);
    expect(parsed.success && parsed.config.withdraw.enabled).toBe(false);
  });
});

describe('describeProgramForAffiliate', () => {
  // Refer a Friend paid in money, with withdrawals on.
  const moneyFriend: ProgramConfig = {
    ...referAFriend,
    reward: { type: 'MONEY', pointsPerBirr: 10 },
    withdraw: { ...referAFriend.withdraw, enabled: true },
  };

  test('explains a money program in customer words', () => {
    const text = describeProgramForAffiliate(moneyFriend);
    expect(text.headline).toBe('Earn 50 ETB for each friend who fully repays a loan.');
    expect(text.friendOffer).toBe('You get 20 ETB when you fully repay a loan.');
    expect(text.payoutNote).toBe('Withdraw your available earnings to your account any time, from 50 ETB.');
    expect(text.lines).toContain('You earn 50 ETB when a friend you invited fully repays a loan (first time only).');
    expect(text.lines).toContain('Your friend gets 20 ETB when they fully repay a loan (first time only).');
    expect(text.lines).toContain('You can earn up to 500 ETB a month.');
    expect(text.lines).toContain('You can withdraw up to 500 ETB a day.');
    expect(text.lines).toContain("Anything you don't withdraw is paid to your account every week once they reach 50 ETB.");
  });

  test('without withdrawals the payout schedule is the payout note', () => {
    const text = describeProgramForAffiliate({ ...moneyFriend, withdraw: { ...moneyFriend.withdraw, enabled: false } });
    expect(text.payoutNote).toBe('Available earnings are paid to your account every week once they reach 50 ETB.');
  });

  test('explains a points program in points, with no money wording', () => {
    const text = describeProgramForAffiliate(referAFriend);
    expect(text.headline).toBe('Earn 500 points for each friend who fully repays a loan.');
    expect(text.friendOffer).toBe('You get 200 points when you fully repay a loan.');
    expect(text.payoutNote).toBe(POINTS_WALLET_NOTE);
    expect(text.lines).toContain('You earn 500 points when a friend you invited fully repays a loan (first time only).');
    expect(text.lines).toContain('You can earn up to 5,000 points a month.');
    expect(text.lines).toContain('New points are on hold for 7 days, then become available.');
    expect(text.lines).toContain('Points are taken back if the loan is cancelled or your friend stops repaying.');
    expect(text.lines.some((l) => /withdraw|tax|ETB/.test(l))).toBe(false);
  });

  test('a percentage rule in points explains the earning rate', () => {
    const shop = programConfigSchema.parse(PROGRAM_TEMPLATES.find((t) => t.key === 'SHOP_PROMOTERS')!.config);
    const points: ProgramConfig = { ...shop, reward: { type: 'POINTS', pointsPerBirr: 20 } };
    const text = describeProgramForAffiliate(points);
    expect(text.lines).toContain(
      'You earn points worth 3% of the order total, up to 10,000 points, when a friend you invited receives a shop order bought on credit (every time).'
    );
    expect(text.lines).toContain('Points are worked out as 20 points for every 1 ETB.');
  });

  test('puts limits and how often in one bracket', () => {
    const agentNetwork = programConfigSchema.parse(PROGRAM_TEMPLATES.find((t) => t.key === 'AGENT_NETWORK')!.config);
    const rule: ProgramConfig['commissionRules'][number] = {
      ...agentNetwork.commissionRules[0],
      filters: { ...agentNetwork.commissionRules[0].filters, minAmount: 1000 },
    };
    expect(describeRuleForAffiliate(rule)).toBe(
      'You earn 150 ETB when a friend you invited fully repays a loan on time (loans of 1,000 ETB or more; first time only).'
    );
    expect(describeRuleForAffiliate(agentNetwork.commissionRules[1])).toBe(
      'You earn 1% of the order total, up to 300 ETB, when a friend you invited receives a shop order bought on credit (every time).'
    );
  });

  test('leaves out rules that are turned off', () => {
    const config = { ...referAFriend, commissionRules: referAFriend.commissionRules.map((r, i) => ({ ...r, enabled: i === 0 })) };
    const text = describeProgramForAffiliate(config);
    expect(text.friendOffer).toBeNull();
    expect(text.lines.some((l) => l.startsWith('Your friend gets'))).toBe(false);
  });
});
