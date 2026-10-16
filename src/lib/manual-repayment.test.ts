import { describe, expect, test } from 'vitest';
import {
  DEFAULT_POLICY,
  activeReferenceKey,
  allocationFor,
  normalizeReference,
  repaymentStatusLabel,
  retiredReferenceKey,
  splitAcrossBuckets,
  toPolicy,
  validateRepaymentEntry,
  type LoanBalanceSnapshot,
  type ManualRepaymentPolicy,
} from './manual-repayment';

const TODAY = new Date(2026, 9, 15, 23, 59, 59, 999); // 15 Oct 2026, end of day
const DISBURSED = new Date(2026, 5, 1);

const context = (overrides?: Partial<Parameters<typeof validateRepaymentEntry>[1]>) => ({
  policy: DEFAULT_POLICY,
  payableNow: 5_000,
  loanRepaymentStatus: 'Unpaid',
  loanDisbursedDate: DISBURSED,
  today: TODAY,
  ...overrides,
});

const entry = (overrides?: Partial<Parameters<typeof validateRepaymentEntry>[0]>) => ({
  amount: 1_000,
  paymentSource: 'CASH',
  referenceNumber: 'RCPT-001',
  paymentDate: new Date(2026, 9, 14),
  hasAttachment: false,
  ...overrides,
});

describe('validateRepaymentEntry', () => {
  test('accepts a repayment within the amount due', () => {
    const { errors, warnings } = validateRepaymentEntry(entry(), context());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('refuses a payment date in the future', () => {
    const { errors } = validateRepaymentEntry(
      entry({ paymentDate: new Date(2026, 9, 16) }),
      context(),
    );
    expect(errors).toContain('The payment date cannot be in the future.');
  });

  test('allows a payment dated today', () => {
    const { errors } = validateRepaymentEntry(
      entry({ paymentDate: new Date(2026, 9, 15) }),
      context(),
    );
    expect(errors).toEqual([]);
  });

  test('refuses a payment dated before the loan was disbursed', () => {
    const { errors } = validateRepaymentEntry(
      entry({ paymentDate: new Date(2026, 4, 31) }),
      context(),
    );
    expect(errors).toContain('The payment date cannot be before the loan was disbursed.');
  });

  test('refuses a repayment against a closed loan', () => {
    const { errors } = validateRepaymentEntry(entry(), context({ loanRepaymentStatus: 'Paid' }));
    expect(errors[0]).toMatch(/already closed/);
  });

  test('refuses a repayment when nothing is due', () => {
    const { errors } = validateRepaymentEntry(entry(), context({ payableNow: 0 }));
    expect(errors).toContain('This loan has nothing due to settle right now.');
  });

  /**
   * The shared posting engine refuses an overpayment outright rather than posting
   * what fits, so there is no "warn and post" mode to offer here — an amount over
   * the quote is always an error.
   */
  test('rejects an amount above what is due now, with no warn-only mode', () => {
    const { errors, warnings } = validateRepaymentEntry(entry({ amount: 5_001 }), context());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/more than the/);
    expect(warnings).toEqual([]);
  });

  test('tolerates a rounding-sized excess over the quote', () => {
    const { errors } = validateRepaymentEntry(entry({ amount: 5_000.005 }), context());
    expect(errors).toEqual([]);
  });

  test("enforces the maker's approval limit", () => {
    const policy: ManualRepaymentPolicy = { ...DEFAULT_POLICY, makerApprovalLimit: 500 };
    const { errors } = validateRepaymentEntry(entry({ amount: 501 }), context({ policy }));
    expect(errors.some((e) => e.includes('approval limit'))).toBe(true);
  });

  test('requires a receipt when policy says so', () => {
    const policy: ManualRepaymentPolicy = { ...DEFAULT_POLICY, requireAttachment: true };
    expect(validateRepaymentEntry(entry(), context({ policy })).errors).toContain(
      'A receipt or bank slip must be attached.',
    );
    expect(validateRepaymentEntry(entry({ hasAttachment: true }), context({ policy })).errors).toEqual(
      [],
    );
  });

  test('requires an amount, a source and a reference', () => {
    const { errors } = validateRepaymentEntry(
      entry({ amount: 0, paymentSource: 'MOBILE_MONEY', referenceNumber: '   ' }),
      context(),
    );
    expect(errors).toContain('Repayment amount must be greater than zero.');
    expect(errors).toContain('Select a valid payment source.');
    expect(errors).toContain('A transaction / reference number is required.');
  });
});

describe('reference numbers', () => {
  test('normalises case and spacing so "ft 123" collides with "FT123"', () => {
    expect(normalizeReference(' ft 123 ')).toBe('FT123');
    expect(activeReferenceKey('CASH', ' rcpt-1 ')).toBe(activeReferenceKey('CASH', 'RCPT-1'));
  });

  test('the same reference under two sources does not collide', () => {
    expect(activeReferenceKey('CASH', 'R-1')).not.toBe(activeReferenceKey('CHEQUE', 'R-1'));
  });

  test('a retired key frees the reference for re-entry after a rejection', () => {
    const active = activeReferenceKey('CASH', 'R-1');
    const retired = retiredReferenceKey('CASH', 'R-1', 'cmr123');
    expect(retired).not.toBe(active);
    expect(retired.startsWith(active)).toBe(true);
    // Two retired rows carrying the same reference still do not collide.
    expect(retired).not.toBe(retiredReferenceKey('CASH', 'R-1', 'cmr456'));
  });
});

/**
 * The split must follow the order applyBnplRepayment consumes the buckets in:
 * penalty -> service fee -> interest -> tax -> principal.
 */
describe('splitAcrossBuckets', () => {
  const due = { penalty: 50, serviceFee: 100, interest: 25, tax: 10, principal: 1_000 };

  test('fills each bucket in turn', () => {
    expect(splitAcrossBuckets(200, due)).toEqual({
      penalty: 50,
      serviceFee: 100,
      interest: 25,
      tax: 10,
      principal: 15,
    });
  });

  test('stops when the money runs out', () => {
    expect(splitAcrossBuckets(60, due)).toEqual({
      penalty: 50,
      serviceFee: 10,
      interest: 0,
      tax: 0,
      principal: 0,
    });
  });

  test('never allocates more than is due in a bucket', () => {
    const split = splitAcrossBuckets(10_000, due);
    expect(split).toEqual(due);
  });

  test('a zero or negative amount allocates nothing', () => {
    expect(splitAcrossBuckets(0, due)).toEqual({
      penalty: 0,
      serviceFee: 0,
      interest: 0,
      tax: 0,
      principal: 0,
    });
    expect(splitAcrossBuckets(-5, due)).toEqual({
      penalty: 0,
      serviceFee: 0,
      interest: 0,
      tax: 0,
      principal: 0,
    });
  });
});

describe('allocationFor', () => {
  const balance: LoanBalanceSnapshot = {
    penalty: 50,
    serviceFee: 100,
    interest: 0,
    tax: 0,
    principal: 500,
    total: 650,
    payableNow: 650,
    installmentNumber: 1,
  };

  test('maps the split onto the bucket keys the audit trail stores', () => {
    expect(allocationFor(200, balance)).toEqual({
      PENALTY: 50,
      SERVICE_FEE: 100,
      INTEREST: 0,
      TAX: 0,
      PRINCIPAL: 50,
    });
  });

  test('a full settlement clears every bucket', () => {
    const all = allocationFor(650, balance);
    expect(all.PENALTY + all.SERVICE_FEE + all.INTEREST + all.TAX + all.PRINCIPAL).toBe(650);
  });
});

describe('toPolicy', () => {
  test('an absent config row yields the defaults', () => {
    expect(toPolicy(null)).toEqual(DEFAULT_POLICY);
  });

  test('a zero or negative approval limit means "no limit", not "nothing may be paid"', () => {
    const row = { makerApprovalLimit: 0, requireAttachment: true, notifyCustomer: false };
    expect(toPolicy(row).makerApprovalLimit).toBeNull();
    expect(toPolicy(row).requireAttachment).toBe(true);
    expect(toPolicy(row).notifyCustomer).toBe(false);
  });
});

describe('repaymentStatusLabel', () => {
  test('reports Fully Paid / Partially Paid / Unpaid', () => {
    expect(repaymentStatusLabel(0, true)).toBe('Fully Paid');
    expect(repaymentStatusLabel(0.005, true)).toBe('Fully Paid');
    expect(repaymentStatusLabel(250, true)).toBe('Partially Paid');
    expect(repaymentStatusLabel(250, false)).toBe('Unpaid');
  });
});
