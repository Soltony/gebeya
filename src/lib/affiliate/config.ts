/**
 * Affiliate program configuration: the settings and commission rules an admin
 * builds for each program. Stored as JSON on AffiliateProgramVersion.config
 * and validated here, on the client (program builder) and again on the server
 * (request + approval), so a stored config is always well-formed.
 *
 * This module is shared by client and server code: keep it free of Prisma and
 * Node-only imports.
 */
import { z, type ZodError } from 'zod';

export const AFFILIATE_TYPES = ['AGENT', 'BORROWER', 'MERCHANT', 'PARTNER', 'STAFF'] as const;
export type AffiliateType = (typeof AFFILIATE_TYPES)[number];

export const COMMISSION_EVENTS = [
  'LOAN_DISBURSED',
  'LOAN_REPAID',
  'BNPL_ORDER_DELIVERED',
  'DIRECT_ORDER_PAID',
] as const;
export type CommissionEvent = (typeof COMMISSION_EVENTS)[number];

export const COMMISSION_BASES = ['PRINCIPAL', 'SERVICE_FEE', 'FEES_COLLECTED', 'ORDER_TOTAL'] as const;
export type CommissionBase = (typeof COMMISSION_BASES)[number];

export const BENEFICIARIES = ['AFFILIATE', 'CUSTOMER'] as const;
export type Beneficiary = (typeof BENEFICIARIES)[number];

// MERCHANT funding needs the BNPL merchant settlement to deduct the
// commission, so it is not offered yet.
export const FUNDING_SOURCES = ['PLATFORM', 'PROVIDER'] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

export const REPAYMENT_BEHAVIORS = ['EARLY', 'ON_TIME', 'LATE'] as const;
export type RepaymentBehavior = (typeof REPAYMENT_BEHAVIORS)[number];

export const LOAN_KINDS = ['PERSONAL', 'BNPL'] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];

export const OCCURRENCE_MODES = ['FIRST', 'FIRST_N', 'EVERY'] as const;
export type OccurrenceMode = (typeof OCCURRENCE_MODES)[number];

export const PAYOUT_SCHEDULES = ['WEEKLY', 'MONTHLY', 'MANUAL'] as const;
export type PayoutSchedule = (typeof PAYOUT_SCHEDULES)[number];

// MONEY rewards are paid out in Birr; POINTS rewards go to the points wallet.
export const REWARD_TYPES = ['MONEY', 'POINTS'] as const;
export type RewardType = (typeof REWARD_TYPES)[number];

// Referral links, USSD and agent-assisted capture come later.
export const REFERRAL_CHANNELS = ['CODE'] as const;
export type ReferralChannel = (typeof REFERRAL_CHANNELS)[number];

export const FILTER_KEYS = [
  'providerIds',
  'productIds',
  'loanKinds',
  'merchantIds',
  'categoryIds',
  'repaymentBehaviors',
  'minAmount',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** Bases a percentage rule may use for each event. */
export const BASES_BY_EVENT: Record<CommissionEvent, readonly CommissionBase[]> = {
  LOAN_DISBURSED: ['PRINCIPAL', 'SERVICE_FEE'],
  LOAN_REPAID: ['PRINCIPAL', 'SERVICE_FEE', 'FEES_COLLECTED'],
  BNPL_ORDER_DELIVERED: ['ORDER_TOTAL', 'PRINCIPAL'],
  DIRECT_ORDER_PAID: ['ORDER_TOTAL'],
};

/** Filters that apply to each event. */
export const FILTERS_BY_EVENT: Record<CommissionEvent, readonly FilterKey[]> = {
  LOAN_DISBURSED: ['providerIds', 'productIds', 'loanKinds', 'minAmount'],
  LOAN_REPAID: ['providerIds', 'productIds', 'loanKinds', 'repaymentBehaviors', 'minAmount'],
  BNPL_ORDER_DELIVERED: ['providerIds', 'productIds', 'merchantIds', 'categoryIds', 'minAmount'],
  DIRECT_ORDER_PAID: ['merchantIds', 'categoryIds', 'minAmount'],
};

export const CURRENCY = 'ETB';

export const AFFILIATE_TYPE_LABELS: Record<AffiliateType, string> = {
  AGENT: 'Agent',
  BORROWER: 'Borrower',
  MERCHANT: 'Merchant',
  PARTNER: 'Partner / influencer',
  STAFF: 'Staff',
};

export const EVENT_LABELS: Record<CommissionEvent, string> = {
  LOAN_DISBURSED: 'Loan disbursed',
  LOAN_REPAID: 'Loan fully repaid',
  BNPL_ORDER_DELIVERED: 'BNPL order delivered',
  DIRECT_ORDER_PAID: 'Direct-payment order paid',
};

export const BASE_LABELS: Record<CommissionBase, string> = {
  PRINCIPAL: 'loan amount',
  SERVICE_FEE: 'service fee',
  FEES_COLLECTED: 'fees actually collected',
  ORDER_TOTAL: 'order total',
};

export const BENEFICIARY_LABELS: Record<Beneficiary, string> = {
  AFFILIATE: 'Affiliate',
  CUSTOMER: 'New customer (welcome bonus)',
};

export const FUNDING_LABELS: Record<FundingSource, string> = {
  PLATFORM: 'Platform',
  PROVIDER: 'Loan provider',
};

export const REPAYMENT_BEHAVIOR_LABELS: Record<RepaymentBehavior, string> = {
  EARLY: 'Early',
  ON_TIME: 'On time',
  LATE: 'Late',
};

export const LOAN_KIND_LABELS: Record<LoanKind, string> = {
  PERSONAL: 'Personal loans',
  BNPL: 'BNPL loans',
};

export const OCCURRENCE_LABELS: Record<OccurrenceMode, string> = {
  FIRST: 'First time only',
  FIRST_N: 'First N times',
  EVERY: 'Every time',
};

export const PAYOUT_SCHEDULE_LABELS: Record<PayoutSchedule, string> = {
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  MANUAL: 'Manual only',
};

export const REWARD_TYPE_LABELS: Record<RewardType, string> = {
  MONEY: 'Money (paid out in Birr)',
  POINTS: 'Points (added to the points wallet)',
};

const money = z.number({ invalid_type_error: 'Enter a number' }).finite().nonnegative();

const filtersSchema = z.object({
  providerIds: z.array(z.string().min(1)).max(200).default([]),
  productIds: z.array(z.string().min(1)).max(500).default([]),
  loanKinds: z.array(z.enum(LOAN_KINDS)).default([]),
  merchantIds: z.array(z.string().min(1)).max(500).default([]),
  categoryIds: z.array(z.string().min(1)).max(500).default([]),
  repaymentBehaviors: z.array(z.enum(REPAYMENT_BEHAVIORS)).default([]),
  // The loan amount (loan events) or order total (order events) must be at least this.
  minAmount: money.nullable().default(null),
});

const calcSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('FIXED'),
    amount: z.number({ invalid_type_error: 'Enter an amount' }).finite().positive('Amount must be more than 0').max(1_000_000),
  }),
  z.object({
    type: z.literal('PERCENT'),
    percent: z.number({ invalid_type_error: 'Enter a percentage' }).finite().positive('Percentage must be more than 0').max(100),
    base: z.enum(COMMISSION_BASES),
    min: money.nullable().default(null),
    max: money.nullable().default(null),
  }),
]);

const occurrenceSchema = z.object({
  mode: z.enum(OCCURRENCE_MODES),
  count: z.number().int().min(1).max(1000).nullable().default(null),
});

const isFilterSet = (value: unknown) => (Array.isArray(value) ? value.length > 0 : value != null);

export const commissionRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1, 'Give the rule a name').max(120),
    enabled: z.boolean().default(true),
    event: z.enum(COMMISSION_EVENTS),
    beneficiary: z.enum(BENEFICIARIES),
    fundedBy: z.enum(FUNDING_SOURCES),
    calc: calcSchema,
    occurrence: occurrenceSchema,
    filters: filtersSchema.default({}),
  })
  .superRefine((rule, ctx) => {
    if (rule.calc.type === 'PERCENT') {
      if (!BASES_BY_EVENT[rule.event].includes(rule.calc.base)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['calc', 'base'],
          message: `"${BASE_LABELS[rule.calc.base]}" can't be used with "${EVENT_LABELS[rule.event]}"`,
        });
      }
      if (rule.calc.min != null && rule.calc.max != null && rule.calc.min > rule.calc.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['calc', 'max'],
          message: 'Maximum must be greater than or equal to the minimum',
        });
      }
    }
    if (rule.event === 'DIRECT_ORDER_PAID' && rule.fundedBy === 'PROVIDER') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fundedBy'],
        message: 'Direct-payment orders have no loan provider; choose Platform',
      });
    }
    if (rule.occurrence.mode === 'FIRST_N' && !rule.occurrence.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['occurrence', 'count'],
        message: 'Enter how many times the rule pays',
      });
    }
    const allowed = FILTERS_BY_EVENT[rule.event];
    for (const key of FILTER_KEYS) {
      if (!allowed.includes(key) && isFilterSet(rule.filters[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['filters', key],
          message: `This filter doesn't apply to "${EVENT_LABELS[rule.event]}"`,
        });
      }
    }
  });

export const programConfigSchema = z
  .object({
    allowedAffiliateTypes: z.array(z.enum(AFFILIATE_TYPES)).min(1, 'Choose at least one affiliate type'),
    attribution: z
      .object({
        channels: z.array(z.enum(REFERRAL_CHANNELS)).default(['CODE']),
        newCustomersOnly: z.boolean().default(true),
        // Loans and orders started more than this many days after the referral don't earn.
        referralValidDays: z.number().int().min(1).max(3650).nullable().default(null),
        maxReferralsPerAffiliatePerDay: z.number().int().min(1).max(100_000).nullable().default(null),
      })
      .default({}),
    commissionRules: z.array(commissionRuleSchema).min(1, 'Add at least one commission rule').max(50),
    // Rules always work out the reward in Birr. POINTS programs credit it as
    // points: amount × pointsPerBirr, using the rate in force when the reward
    // is recorded. Programs stored before points existed read as MONEY.
    reward: z
      .object({
        type: z.enum(REWARD_TYPES).default('MONEY'),
        pointsPerBirr: z
          .number({ invalid_type_error: 'Enter a number' })
          .finite()
          .positive('Must be more than 0')
          .max(10_000)
          .default(10),
      })
      .default({}),
    holdDays: z.number().int().min(0).max(365).default(0),
    clawback: z
      .object({
        onNpl: z.boolean().default(true),
        nplWindowDays: z.number().int().min(1).max(3650).default(180),
      })
      .default({}),
    caps: z
      .object({
        perReferralTotal: money.nullable().default(null),
        perAffiliatePerMonth: money.nullable().default(null),
        programBudget: money.nullable().default(null),
      })
      .default({}),
    payout: z
      .object({
        schedule: z.enum(PAYOUT_SCHEDULES).default('MONTHLY'),
        minimumAmount: money.default(0),
        withholdingTaxPercent: z.number().finite().min(0).max(100).default(0),
      })
      .default({}),
    // Customers get their own code on the mini-app's Earn page without an
    // approval each: these rules were approved once, with the program.
    selfJoin: z
      .object({
        enabled: z.boolean().default(false),
        minRepaidLoans: z.number().int().min(0).max(100).default(1),
        blockIfOverdue: z.boolean().default(true),
        allowCustomCode: z.boolean().default(true),
      })
      .default({}),
    // People withdraw their available earnings on the Earn page, always to
    // their own account. Up to autoApproveUpTo the money is sent at once;
    // larger withdrawals wait for a checker in Affiliates → Payouts.
    withdraw: z
      .object({
        enabled: z.boolean().default(false),
        minimum: money.default(50),
        maxPerDay: money.nullable().default(null),
        maxPerMonth: money.nullable().default(null),
        autoApproveUpTo: money.default(0),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    const { withdraw } = config;
    if (withdraw.maxPerDay != null && withdraw.maxPerDay < withdraw.minimum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['withdraw', 'maxPerDay'],
        message: 'Must be at least the minimum withdrawal',
      });
    }
    if (withdraw.maxPerMonth != null && withdraw.maxPerMonth < (withdraw.maxPerDay ?? withdraw.minimum)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['withdraw', 'maxPerMonth'],
        message: 'Must be at least the daily maximum (or the minimum withdrawal)',
      });
    }
    if (config.selfJoin.enabled && !config.allowedAffiliateTypes.includes('BORROWER')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selfJoin'],
        message: 'Add Borrower to "Who can join" so customers can get their own code',
      });
    }
    const seen = new Set<string>();
    config.commissionRules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['commissionRules', index, 'id'],
          message: 'Two rules have the same id',
        });
      }
      seen.add(rule.id);
    });
    if (config.commissionRules.length > 0 && !config.commissionRules.some((rule) => rule.enabled)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commissionRules'],
        message: 'Turn on at least one commission rule',
      });
    }
  });

export type ProgramConfig = z.infer<typeof programConfigSchema>;
export type ProgramConfigInput = z.input<typeof programConfigSchema>;
export type CommissionRule = z.infer<typeof commissionRuleSchema>;
export type CommissionRuleInput = z.input<typeof commissionRuleSchema>;
export type RuleFilters = CommissionRule['filters'];

const PATH_LABELS: Record<string, string> = {
  allowedAffiliateTypes: 'Who can join',
  attribution: 'Referrals',
  channels: 'Channels',
  newCustomersOnly: 'New customers only',
  referralValidDays: 'Referral valid for (days)',
  maxReferralsPerAffiliatePerDay: 'Max new referrals per affiliate per day',
  commissionRules: 'Commission rules',
  holdDays: 'Hold period (days)',
  clawback: 'Take-backs',
  nplWindowDays: 'NPL take-back window (days)',
  caps: 'Caps',
  perReferralTotal: 'Max per referred customer',
  perAffiliatePerMonth: 'Max per affiliate per month',
  programBudget: 'Program budget',
  payout: 'Payouts',
  minimumAmount: 'Minimum payout',
  withholdingTaxPercent: 'Withholding tax %',
  calc: 'Calculation',
  amount: 'Amount',
  percent: 'Percentage',
  base: 'Percentage of',
  min: 'Minimum',
  max: 'Maximum',
  occurrence: 'How often',
  count: 'Number of times',
  fundedBy: 'Paid by',
  filters: 'Filters',
  minAmount: 'Minimum loan/order amount',
  name: 'Name',
  selfJoin: 'Customer sign-up',
  minRepaidLoans: 'Repaid loans needed',
  reward: 'Rewards',
  pointsPerBirr: 'Points per 1 ETB',
  pointValue: 'Value of 1 point',
  shop: 'Shop',
  repayment: 'Loan repayment',
  withdrawal: 'Withdrawal',
  birrPerPoint: 'ETB per point',
  minPoints: 'Minimum points',
  maxPointsPerDay: 'Max points per day',
  maxPointsPerMonth: 'Max points per month',
  withdraw: 'Withdrawals',
  minimum: 'Minimum withdrawal',
  maxPerDay: 'Max per day',
  maxPerMonth: 'Max per month',
  autoApproveUpTo: 'Send automatically up to',
};

/** Turns zod issues into short, readable messages for the program builder. */
export function formatConfigErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const parts: string[] = [];
    for (let i = 0; i < issue.path.length; i++) {
      const segment = issue.path[i];
      if (segment === 'commissionRules' && typeof issue.path[i + 1] === 'number') {
        parts.push(`Rule ${(issue.path[i + 1] as number) + 1}`);
        i++;
        continue;
      }
      if (typeof segment === 'number') continue;
      parts.push(PATH_LABELS[segment] ?? segment);
    }
    return parts.length ? `${parts.join(' › ')}: ${issue.message}` : issue.message;
  });
}

export type ConfigParseResult =
  | { success: true; config: ProgramConfig }
  | { success: false; errors: string[] };

export function parseProgramConfig(input: unknown): ConfigParseResult {
  const result = programConfigSchema.safeParse(input);
  if (result.success) return { success: true, config: result.data };
  return { success: false, errors: formatConfigErrors(result.error) };
}

/** Reads a config stored on AffiliateProgramVersion; throws when it is not valid. */
export function readStoredConfig(json: string): ProgramConfig {
  const result = parseProgramConfig(JSON.parse(json));
  if (!result.success) {
    throw new Error(`Stored affiliate program config is invalid: ${result.errors.join('; ')}`);
  }
  return result.config;
}

export const REFERRAL_CODE_PATTERN = /^[A-Z0-9]{4,16}$/;

export function normalizeReferralCode(input: string): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

export function formatMoney(value: number | null | undefined): string {
  // Tolerates null so half-filled drafts in the program builder still render.
  const n = Number(value ?? 0);
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${CURRENCY}`;
}

export function formatPoints(value: number | null | undefined): string {
  const n = Math.round(Number(value ?? 0));
  return `${n.toLocaleString('en-US')} ${Math.abs(n) === 1 ? 'point' : 'points'}`;
}

/** Whole points for a reward of `amount` Birr. */
export function pointsForAmount(amount: number, pointsPerBirr: number): number {
  return Math.round(amount * pointsPerBirr);
}

// ---------------------------------------------------------------------------
// Points settings: one set for the whole points wallet, so a point is worth
// the same whichever program gave it. Versioned and changed through
// maker-checker; how points can be used will be added here later.
// ---------------------------------------------------------------------------

export const POINT_USES = ['shop', 'repayment', 'withdrawal'] as const;
export type PointUse = (typeof POINT_USES)[number];

export const POINT_USE_LABELS: Record<PointUse, string> = {
  shop: 'Shop',
  repayment: 'Loan repayment',
  withdrawal: 'Withdrawal',
};

const pointsUseSchema = z.object({
  enabled: z.boolean().default(false),
  // ETB one point buys for this use; empty = the point value.
  birrPerPoint: z.number({ invalid_type_error: 'Enter a number' }).finite().positive('Must be more than 0').max(1000).nullable().default(null),
  minPoints: z.number().int().min(1).max(10_000_000).default(100),
  maxPointsPerDay: z.number().int().positive().max(1_000_000_000).nullable().default(null),
  maxPointsPerMonth: z.number().int().positive().max(1_000_000_000).nullable().default(null),
});

export const pointsSettingsSchema = z
  .object({
    // Shown to people next to their balance ("≈ 245 ETB") and used to value
    // points in reports, and what a point buys when a use has no rate of its own.
    pointValue: z.number({ invalid_type_error: 'Enter a number' }).finite().positive('Must be more than 0').max(1000).default(0.1),
    shop: pointsUseSchema.default({}),
    repayment: pointsUseSchema.default({}),
    // Withdrawals up to autoApproveUpTo ETB are sent at once; larger ones wait for a checker.
    withdrawal: pointsUseSchema.extend({ autoApproveUpTo: money.default(0) }).default({}),
  })
  .superRefine((settings, ctx) => {
    for (const use of POINT_USES) {
      const s = settings[use];
      if (s.maxPointsPerDay != null && s.maxPointsPerDay < s.minPoints) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [use, 'maxPointsPerDay'], message: 'Must be at least the minimum points' });
      }
      if (s.maxPointsPerMonth != null && s.maxPointsPerMonth < (s.maxPointsPerDay ?? s.minPoints)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [use, 'maxPointsPerMonth'], message: 'Must be at least the daily maximum' });
      }
    }
  });

export type PointsSettings = z.infer<typeof pointsSettingsSchema>;

export const DEFAULT_POINTS_SETTINGS: PointsSettings = pointsSettingsSchema.parse({});

/** ETB one point buys for a use: its own rate, or the point value. */
export function birrPerPoint(settings: PointsSettings, use: PointUse): number {
  return settings[use].birrPerPoint ?? settings.pointValue;
}

type NameLookup = Record<string, string | undefined>;

export type DescribeLookups = {
  providers?: NameLookup;
  products?: NameLookup;
  merchants?: NameLookup;
  categories?: NameLookup;
};

function joinNames(ids: string[], lookup: NameLookup | undefined, noun: string) {
  if (!lookup) return `${ids.length} ${noun}${ids.length === 1 ? '' : 's'}`;
  const names = ids.map((id) => lookup[id] ?? id);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
}

function describeTrigger(rule: CommissionRule): string {
  const behaviors = rule.filters.repaymentBehaviors;
  switch (rule.event) {
    case 'LOAN_DISBURSED':
      return "a referred customer's loan is disbursed";
    case 'LOAN_REPAID':
      return behaviors.length
        ? `a referred customer's loan is fully repaid (${behaviors.map((b) => REPAYMENT_BEHAVIOR_LABELS[b].toLowerCase()).join(' or ')})`
        : "a referred customer's loan is fully repaid";
    case 'BNPL_ORDER_DELIVERED':
      return "a referred customer's BNPL order is delivered";
    case 'DIRECT_ORDER_PAID':
      return 'a referred customer pays for an order directly';
  }
}

function describeAmount(rule: CommissionRule): string {
  if (rule.calc.type === 'FIXED') return formatMoney(rule.calc.amount);
  const limits: string[] = [];
  if (rule.calc.min != null) limits.push(`min ${formatMoney(rule.calc.min)}`);
  if (rule.calc.max != null) limits.push(`max ${formatMoney(rule.calc.max)}`);
  return `${rule.calc.percent}% of the ${BASE_LABELS[rule.calc.base]}${limits.length ? ` (${limits.join(', ')})` : ''}`;
}

function describeOccurrence(rule: CommissionRule): string {
  if (rule.occurrence.mode === 'FIRST') return 'first time only';
  if (rule.occurrence.mode === 'FIRST_N') return `first ${rule.occurrence.count} times`;
  return 'every time';
}

/** One plain-language sentence for a rule, for the builder, lists and approvals. */
export function describeRule(rule: CommissionRule, lookups: DescribeLookups = {}): string {
  const who = rule.beneficiary === 'AFFILIATE' ? 'the affiliate' : 'the new customer';
  const conditions: string[] = [];
  const f = rule.filters;
  if (f.providerIds.length) conditions.push(`provider: ${joinNames(f.providerIds, lookups.providers, 'provider')}`);
  if (f.productIds.length) conditions.push(`product: ${joinNames(f.productIds, lookups.products, 'product')}`);
  if (f.loanKinds.length) conditions.push(f.loanKinds.map((k) => LOAN_KIND_LABELS[k].toLowerCase()).join(' or '));
  if (f.merchantIds.length) conditions.push(`merchant: ${joinNames(f.merchantIds, lookups.merchants, 'merchant')}`);
  if (f.categoryIds.length) conditions.push(`category: ${joinNames(f.categoryIds, lookups.categories, 'category')}`);
  if (f.minAmount != null) conditions.push(`amount at least ${formatMoney(f.minAmount)}`);
  const onlyIf = conditions.length ? ` Only for ${conditions.join('; ')}.` : '';
  const off = rule.enabled ? '' : ' (turned off)';
  return `When ${describeTrigger(rule)}, pay ${who} ${describeAmount(rule)}, ${describeOccurrence(rule)}. Paid by the ${FUNDING_LABELS[rule.fundedBy].toLowerCase()}.${onlyIf}${off}`;
}

/** Plain-language summary of a whole program, shown to approvers. */
export function describeProgram(config: ProgramConfig, lookups: DescribeLookups = {}): string[] {
  const lines: string[] = [];
  lines.push(`Who can join: ${config.allowedAffiliateTypes.map((t) => AFFILIATE_TYPE_LABELS[t]).join(', ')}.`);
  if (config.selfJoin.enabled) {
    const needs: string[] = [];
    if (config.selfJoin.minRepaidLoans > 0) {
      needs.push(`${config.selfJoin.minRepaidLoans} fully repaid loan${config.selfJoin.minRepaidLoans === 1 ? '' : 's'}`);
    }
    if (config.selfJoin.blockIfOverdue) needs.push('nothing overdue');
    lines.push(
      `Customer sign-up: customers get their own code in the mini-app without approval${
        needs.length ? ` (needs ${needs.join(' and ')})` : ''
      }${config.selfJoin.allowCustomCode ? '; they can change it once' : ''}.`
    );
  }
  const referral: string[] = [];
  referral.push(config.attribution.channels.includes('CODE') ? 'customers enter a code in the mini-app' : 'not accepting new referrals');
  referral.push(config.attribution.newCustomersOnly ? 'new customers only' : 'new and existing customers');
  if (config.attribution.referralValidDays) referral.push(`valid for ${config.attribution.referralValidDays} days`);
  if (config.attribution.maxReferralsPerAffiliatePerDay) {
    referral.push(`max ${config.attribution.maxReferralsPerAffiliatePerDay} new referrals per affiliate per day`);
  }
  lines.push(`Referrals: ${referral.join(', ')}.`);
  config.commissionRules.forEach((rule, i) => lines.push(`Rule ${i + 1} (${rule.name}): ${describeRule(rule, lookups)}`));
  lines.push(
    config.reward.type === 'POINTS'
      ? `Rewards: added to the points wallet as points, ${config.reward.pointsPerBirr} points for every 1 ETB of reward. Nothing is paid out in money.`
      : 'Rewards: paid out in money.'
  );
  lines.push(
    `Hold: ${config.holdDays} day(s). Take-backs: always when a loan is reversed${
      config.clawback.onNpl ? `; when the customer becomes NPL within ${config.clawback.nplWindowDays} days` : ''
    }.`
  );
  const caps: string[] = [];
  if (config.caps.perReferralTotal != null) caps.push(`${formatMoney(config.caps.perReferralTotal)} per referred customer`);
  if (config.caps.perAffiliatePerMonth != null) caps.push(`${formatMoney(config.caps.perAffiliatePerMonth)} per affiliate per month`);
  if (config.caps.programBudget != null) caps.push(`${formatMoney(config.caps.programBudget)} total budget`);
  lines.push(`Caps: ${caps.length ? caps.join(', ') : 'none'}.`);
  lines.push(
    `Payouts: ${PAYOUT_SCHEDULE_LABELS[config.payout.schedule].toLowerCase()}, minimum ${formatMoney(config.payout.minimumAmount)}, withholding tax ${config.payout.withholdingTaxPercent}%. Every payout batch needs approval.`
  );
  if (config.withdraw.enabled) {
    const w = config.withdraw;
    const limits: string[] = [`from ${formatMoney(w.minimum)}`];
    if (w.maxPerDay != null) limits.push(`max ${formatMoney(w.maxPerDay)} a day`);
    if (w.maxPerMonth != null) limits.push(`max ${formatMoney(w.maxPerMonth)} a month`);
    lines.push(
      `Withdrawals: people withdraw their available earnings in the mini-app to their own account (${limits.join(', ')}). ${
        w.autoApproveUpTo > 0
          ? `Up to ${formatMoney(w.autoApproveUpTo)} is sent at once; larger withdrawals need a checker.`
          : 'Every withdrawal needs a checker.'
      }`
    );
  }
  return lines;
}

export type ProgramTemplate = {
  key: string;
  name: string;
  description: string;
  config: ProgramConfigInput;
};

// Example amounts only; admins adjust them before submitting.
export const PROGRAM_TEMPLATES: ProgramTemplate[] = [
  {
    key: 'AGENT_NETWORK',
    name: 'Agent Network',
    description: 'Agents added by an admin earn when the customers they bring repay their first loan on time.',
    config: {
      allowedAffiliateTypes: ['AGENT', 'PARTNER', 'STAFF'],
      attribution: { channels: ['CODE'], newCustomersOnly: true, referralValidDays: 90, maxReferralsPerAffiliatePerDay: 50 },
      commissionRules: [
        {
          id: 'first-loan-repaid',
          name: 'First loan repaid on time',
          enabled: true,
          event: 'LOAN_REPAID',
          beneficiary: 'AFFILIATE',
          fundedBy: 'PLATFORM',
          calc: { type: 'FIXED', amount: 150 },
          occurrence: { mode: 'FIRST', count: null },
          filters: { repaymentBehaviors: ['EARLY', 'ON_TIME'] },
        },
        {
          id: 'bnpl-order-delivered',
          name: 'BNPL order delivered',
          enabled: true,
          event: 'BNPL_ORDER_DELIVERED',
          beneficiary: 'AFFILIATE',
          fundedBy: 'PLATFORM',
          calc: { type: 'PERCENT', percent: 1, base: 'ORDER_TOTAL', min: null, max: 300 },
          occurrence: { mode: 'EVERY', count: null },
          filters: {},
        },
      ],
      holdDays: 14,
      clawback: { onNpl: true, nplWindowDays: 180 },
      caps: { perReferralTotal: 1000, perAffiliatePerMonth: 20000, programBudget: null },
      payout: { schedule: 'MONTHLY', minimumAmount: 200, withholdingTaxPercent: 0 },
      withdraw: { enabled: true, minimum: 200, maxPerDay: 10000, maxPerMonth: 20000, autoApproveUpTo: 2000 },
      reward: { type: 'MONEY', pointsPerBirr: 10 },
    },
  },
  {
    key: 'REFER_A_FRIEND',
    name: 'Refer a Friend',
    description:
      'Customers get their own code in the mini-app and invite friends. Both get a reward when the friend repays their first loan.',
    config: {
      allowedAffiliateTypes: ['BORROWER'],
      attribution: { channels: ['CODE'], newCustomersOnly: true, referralValidDays: 60, maxReferralsPerAffiliatePerDay: 5 },
      commissionRules: [
        {
          id: 'referrer-reward',
          name: 'Reward for the referrer',
          enabled: true,
          event: 'LOAN_REPAID',
          beneficiary: 'AFFILIATE',
          fundedBy: 'PLATFORM',
          calc: { type: 'FIXED', amount: 50 },
          occurrence: { mode: 'FIRST', count: null },
          filters: {},
        },
        {
          id: 'welcome-bonus',
          name: 'Welcome bonus for the new customer',
          enabled: true,
          event: 'LOAN_REPAID',
          beneficiary: 'CUSTOMER',
          fundedBy: 'PLATFORM',
          calc: { type: 'FIXED', amount: 20 },
          occurrence: { mode: 'FIRST', count: null },
          filters: {},
        },
      ],
      holdDays: 7,
      clawback: { onNpl: true, nplWindowDays: 90 },
      caps: { perReferralTotal: 50, perAffiliatePerMonth: 500, programBudget: null },
      payout: { schedule: 'WEEKLY', minimumAmount: 50, withholdingTaxPercent: 0 },
      selfJoin: { enabled: true, minRepaidLoans: 1, blockIfOverdue: true, allowCustomCode: true },
      withdraw: { enabled: false, minimum: 50, maxPerDay: 500, maxPerMonth: null, autoApproveUpTo: 500 },
      reward: { type: 'POINTS', pointsPerBirr: 10 },
    },
  },
  {
    key: 'SHOP_PROMOTERS',
    name: 'Shop Promoters',
    description: 'Promoters earn a share of every shop order their customers complete.',
    config: {
      allowedAffiliateTypes: ['PARTNER', 'MERCHANT'],
      attribution: { channels: ['CODE'], newCustomersOnly: false, referralValidDays: 365, maxReferralsPerAffiliatePerDay: null },
      commissionRules: [
        {
          id: 'bnpl-order-delivered',
          name: 'BNPL order delivered',
          enabled: true,
          event: 'BNPL_ORDER_DELIVERED',
          beneficiary: 'AFFILIATE',
          fundedBy: 'PLATFORM',
          calc: { type: 'PERCENT', percent: 3, base: 'ORDER_TOTAL', min: null, max: 500 },
          occurrence: { mode: 'EVERY', count: null },
          filters: {},
        },
        {
          id: 'direct-order-paid',
          name: 'Direct-payment order paid',
          enabled: true,
          event: 'DIRECT_ORDER_PAID',
          beneficiary: 'AFFILIATE',
          fundedBy: 'PLATFORM',
          calc: { type: 'PERCENT', percent: 2, base: 'ORDER_TOTAL', min: null, max: 300 },
          occurrence: { mode: 'EVERY', count: null },
          filters: {},
        },
      ],
      holdDays: 7,
      clawback: { onNpl: true, nplWindowDays: 90 },
      caps: { perReferralTotal: null, perAffiliatePerMonth: 30000, programBudget: null },
      payout: { schedule: 'MONTHLY', minimumAmount: 200, withholdingTaxPercent: 0 },
      reward: { type: 'MONEY', pointsPerBirr: 10 },
    },
  },
];

export const BLANK_RULE: CommissionRuleInput = {
  id: 'rule-1',
  name: 'New rule',
  enabled: true,
  event: 'LOAN_REPAID',
  beneficiary: 'AFFILIATE',
  fundedBy: 'PLATFORM',
  calc: { type: 'FIXED', amount: 100 },
  occurrence: { mode: 'FIRST', count: null },
  filters: {},
};

export const BLANK_CONFIG: ProgramConfigInput = {
  allowedAffiliateTypes: ['AGENT'],
  attribution: { channels: ['CODE'], newCustomersOnly: true, referralValidDays: null, maxReferralsPerAffiliatePerDay: null },
  commissionRules: [BLANK_RULE],
  holdDays: 7,
  clawback: { onNpl: true, nplWindowDays: 180 },
  caps: { perReferralTotal: null, perAffiliatePerMonth: null, programBudget: null },
  payout: { schedule: 'MONTHLY', minimumAmount: 0, withholdingTaxPercent: 0 },
  selfJoin: { enabled: false, minRepaidLoans: 1, blockIfOverdue: true, allowCustomCode: true },
  withdraw: { enabled: false, minimum: 50, maxPerDay: null, maxPerMonth: null, autoApproveUpTo: 0 },
  // New programs reward in points; agent programs that pay cash pick Money.
  reward: { type: 'POINTS', pointsPerBirr: 10 },
};
