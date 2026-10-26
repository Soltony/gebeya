import { describe, expect, test } from 'vitest';
import { decideTransition, readCallbackResult, readStatusResult, type PushResult } from './outcome';

describe('readCallbackResult', () => {
  test('statusCode 0 is a success', () => {
    const result = readCallbackResult({ transactionRef: 'ref1', statusCode: 0, cbsreference: 'FT25290AAAAA', amount: 250, payerAccount: '1000123456789' });
    expect(result).toEqual({
      outcome: 'SUCCESS',
      transactionRef: 'ref1',
      statusDesc: null,
      cbsReference: 'FT25290AAAAA',
      payerAccount: '1000123456789',
      amount: 250,
    });
  });

  test('reads the callbacks of guide §7.2', () => {
    expect(
      readCallbackResult({
        transactionRef: 'ref1',
        statusDesc: 'Payment successful',
        statusCode: '0',
        cbsreference: 'FT26145XYZ88',
        company: 'GEBEYA',
        amount: '100',
      }),
    ).toMatchObject({ outcome: 'SUCCESS', cbsReference: 'FT26145XYZ88', amount: 100 });

    // A failure carries an empty cbsreference, which is not an FT.
    expect(
      readCallbackResult({ transactionRef: 'ref1', statusDesc: 'Invalid PIN', statusCode: '1', cbsreference: '', amount: '100.0' }),
    ).toMatchObject({ outcome: 'FAILED', cbsReference: null, statusDesc: 'Invalid PIN', amount: 100 });
  });

  test('statusCode 1 is a decline unless money may have moved', () => {
    expect(readCallbackResult({ statusCode: 1, statusDesc: 'Insufficient balance' }).outcome).toBe('FAILED');
    expect(readCallbackResult({ statusCode: 1, statusDesc: 'Failed', cbsreference: 'FT25290AAAAA' }).outcome).toBe('PROCESSING');
    expect(readCallbackResult({ statusCode: 1, statusDesc: 'Server Busy, try later' }).outcome).toBe('PROCESSING');
  });

  test('an unknown or missing statusCode leaves the payment open', () => {
    expect(readCallbackResult({ statusCode: 7 }).outcome).toBe('PENDING');
    expect(readCallbackResult({}).outcome).toBe('PENDING');
  });
});

describe('readStatusResult', () => {
  test('maps paymentStatus', () => {
    expect(readStatusResult({ paymentStatus: 'PAID', transactionRef: 'ref1', cbsreference: 'FT26145XYZ88', amount: 500.0 })).toMatchObject({
      outcome: 'SUCCESS',
      transactionRef: 'ref1',
      cbsReference: 'FT26145XYZ88',
    });
    expect(readStatusResult({ paymentStatus: 'NOT_PAID' }).outcome).toBe('FAILED');
    expect(readStatusResult({ paymentStatus: 'PENDING' }).outcome).toBe('PENDING');
    expect(readStatusResult({ paymentStatus: 'paid' }).outcome).toBe('SUCCESS');
  });

  test('NOT_PAID with an FT or "server busy" is held for review', () => {
    expect(readStatusResult({ paymentStatus: 'NOT_PAID', cbsreference: 'FT25290AAAAA' }).outcome).toBe('PROCESSING');
    expect(readStatusResult({ paymentStatus: 'NOT_PAID', message: 'server busy' }).outcome).toBe('PROCESSING');
  });
});

describe('decideTransition', () => {
  const result = (outcome: PushResult['outcome'], extra: Partial<PushResult> = {}): PushResult => ({
    outcome,
    transactionRef: null,
    statusDesc: null,
    cbsReference: null,
    payerAccount: null,
    amount: null,
    ...extra,
  });

  test('an open attempt takes the bank result', () => {
    for (const current of ['PENDING', 'AWAITING_PIN']) {
      expect(decideTransition(current, result('SUCCESS'), 250)?.to).toBe('COMPLETED');
      expect(decideTransition(current, result('FAILED'), 250)?.to).toBe('FAILED');
      expect(decideTransition(current, result('PROCESSING'), 250)?.to).toBe('PROCESSING');
    }
  });

  test('pending results change nothing', () => {
    expect(decideTransition('AWAITING_PIN', result('PENDING'), 250)).toBeNull();
  });

  test('a completed payment never changes', () => {
    for (const outcome of ['SUCCESS', 'FAILED', 'PROCESSING'] as const) {
      expect(decideTransition('COMPLETED', result(outcome), 250)).toBeNull();
    }
  });

  test('success for a different amount is held for review', () => {
    expect(decideTransition('AWAITING_PIN', result('SUCCESS', { amount: 249 }), 250)?.to).toBe('PROCESSING');
    expect(decideTransition('AWAITING_PIN', result('SUCCESS', { amount: 250.004 }), 250)?.to).toBe('COMPLETED');
  });

  test('success after a recorded failure is held for review, not ignored', () => {
    expect(decideTransition('FAILED', result('SUCCESS'), 250)?.to).toBe('PROCESSING');
    expect(decideTransition('FAILED', result('FAILED'), 250)).toBeNull();
  });

  test('a payment under review settles on success but is never failed', () => {
    expect(decideTransition('PROCESSING', result('SUCCESS'), 250)?.to).toBe('COMPLETED');
    expect(decideTransition('PROCESSING', result('FAILED'), 250)).toBeNull();
    expect(decideTransition('PROCESSING', result('PROCESSING'), 250)).toBeNull();
  });
});
