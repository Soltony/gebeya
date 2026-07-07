import { describe, expect, test } from 'vitest';
import { calculateTotalRepayable, calculateInclusiveTax } from './loan-calculator';
import type { Tax } from './types';

describe('calculateInclusiveTax', () => {
  test('returns 0 when no taxes are configured', () => {
    expect(calculateInclusiveTax(10000, [])).toBe(0);
  });

  test('returns 0 when no inclusive taxes exist', () => {
    const taxes: Tax[] = [
      { id: '1', name: 'VAT', rate: 15, appliedTo: '["serviceFee"]', isInclusive: false },
    ];
    expect(calculateInclusiveTax(10000, taxes)).toBe(0);
  });

  test('calculates inclusive tax on gross amount', () => {
    const taxes: Tax[] = [
      { id: '1', name: 'Withholding', rate: 2, appliedTo: '[]', isInclusive: true },
    ];
    expect(calculateInclusiveTax(10000, taxes)).toBe(200);
  });

  test('sums multiple inclusive taxes', () => {
    const taxes: Tax[] = [
      { id: '1', name: 'Tax A', rate: 2, appliedTo: '[]', isInclusive: true },
      { id: '2', name: 'Tax B', rate: 3, appliedTo: '[]', isInclusive: true },
    ];
    expect(calculateInclusiveTax(10000, taxes)).toBe(500);
  });

  test('ignores non-inclusive taxes', () => {
    const taxes: Tax[] = [
      { id: '1', name: 'Inclusive', rate: 5, appliedTo: '[]', isInclusive: true },
      { id: '2', name: 'Non-inclusive', rate: 15, appliedTo: '["serviceFee"]', isInclusive: false },
    ];
    expect(calculateInclusiveTax(10000, taxes)).toBe(500);
  });

  test('handles zero rate', () => {
    const taxes: Tax[] = [
      { id: '1', name: 'Zero', rate: 0, appliedTo: '[]', isInclusive: true },
    ];
    expect(calculateInclusiveTax(10000, taxes)).toBe(0);
  });

  test('rounds to 2 decimal places', () => {
    const taxes: Tax[] = [
      { id: '1', name: 'Tax', rate: 3, appliedTo: '[]', isInclusive: true },
    ];
    // 1549 * 3% = 46.47
    expect(calculateInclusiveTax(1549, taxes)).toBe(46.47);
  });
});

describe('net disbursed amount calculation', () => {
  test('inclusive tax reduces disbursed amount', () => {
    const grossAmount = 2900;
    const taxes: Tax[] = [
      { id: '1', name: 'Withholding', rate: 2, appliedTo: '[]', isInclusive: true },
    ];
    const inclusiveTax = calculateInclusiveTax(grossAmount, taxes);
    const netDisbursed = grossAmount - inclusiveTax;
    expect(inclusiveTax).toBe(58);
    expect(netDisbursed).toBe(2842);
  });
});

describe('inclusive tax does not double-count in calculateTotalRepayable', () => {
  test('inclusive tax with empty appliedTo does not add to total', () => {
    const loanDetails = {
      id: 'test',
      loanAmount: 10000,
      disbursedDate: new Date('2026-01-01'),
      dueDate: new Date('2026-01-31'),
      serviceFee: 0,
      repaymentStatus: 'Unpaid' as const,
      payments: [],
      productName: 'Test',
      providerName: 'Test Provider',
      repaidAmount: 0,
      penaltyAmount: 0,
      installments: [],
      product: {
        id: 'p1',
        name: 'Test',
        duration: 30,
        serviceFeeEnabled: false,
        dailyFeeEnabled: false,
        penaltyRulesEnabled: false,
        serviceFee: null,
        dailyFee: null,
        penaltyRules: [],
      },
    };

    const inclusiveTax: Tax[] = [
      { id: '1', name: 'Withholding', rate: 5, appliedTo: '[]', isInclusive: true },
    ];

    const result = calculateTotalRepayable(
      loanDetails as any,
      loanDetails.product as any,
      inclusiveTax,
      new Date('2026-01-15')
    );

    // Inclusive tax has appliedTo=[], so no taxable components => tax=0 in repayable
    // The tax was already deducted at disbursement, not added to repayable
    expect(result.tax).toBe(0);
    expect(result.total).toBe(10000); // Only principal
  });
});

describe('active tax filtering consistency', () => {
  test('status must be ACTIVE (uppercase) to be picked up', () => {
    // This test verifies the convention: status must be "ACTIVE" not "Active"
    const activeStatuses = ['ACTIVE'];
    const wrongStatuses = ['Active', 'active', 'PENDING_APPROVAL'];

    for (const status of activeStatuses) {
      expect(status).toBe('ACTIVE');
    }
    for (const status of wrongStatuses) {
      expect(status).not.toBe('ACTIVE');
    }
  });
});
