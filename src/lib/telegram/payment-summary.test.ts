import { describe, expect, test } from 'vitest';
import { summarizeTelegramPayment, type PaymentAttemptForSummary } from './payment-summary';

const now = new Date('2026-10-21T10:00:00Z');
const order = { status: 'ON_DELIVERY', totalAmount: 250, borrowerId: '251911223344' };

function attempt(status: string, secondsAgo: number, extra: Partial<PaymentAttemptForSummary> = {}): PaymentAttemptForSummary {
  return {
    status,
    statusDesc: null,
    amount: 250,
    createdAt: new Date(now.getTime() - secondsAgo * 1000),
    completedAt: null,
    ft: null,
    ...extra,
  };
}

const summarize = (attempts: PaymentAttemptForSummary[], o = order, enabled = true, merchantCanReceive = true) =>
  summarizeTelegramPayment(o, attempts, { enabled, merchantCanReceive, now });

describe('summarizeTelegramPayment', () => {
  test('an order on delivery with no attempts can be paid', () => {
    expect(summarize([])).toMatchObject({ state: 'UNPAID', canPay: true, amount: 250, phone: '2519****3344', message: null });
  });

  test('paying waits for the merchant and stops once the order is closed', () => {
    for (const status of ['PENDING_MERCHANT_CONFIRMATION', 'DELIVERED', 'CANCELLED']) {
      expect(summarize([], { ...order, status }).canPay).toBe(false);
    }
  });

  test('nothing can be paid when push payments are not configured', () => {
    expect(summarize([], order, false)).toMatchObject({ enabled: false, canPay: false });
  });

  test('a merchant without an NIB account cannot be paid, not even by resending', () => {
    expect(summarize([], order, true, false)).toMatchObject({ merchantCanReceive: false, canPay: false });
    expect(summarize([attempt('AWAITING_PIN', 120)], order, true, false).canPay).toBe(false);
  });

  test('a fresh prompt cannot be resent yet; an old one can', () => {
    expect(summarize([attempt('AWAITING_PIN', 20)])).toMatchObject({
      state: 'AWAITING_PIN',
      canPay: false,
      promptSentAt: '2026-10-21T09:59:40.000Z',
    });
    expect(summarize([attempt('AWAITING_PIN', 61)])).toMatchObject({ state: 'AWAITING_PIN', canPay: true });
  });

  test('an unanswered transfer request says so', () => {
    expect(summarize([attempt('PENDING', 5)]).message).toMatch(/couldn't confirm/);
  });

  test('the last failure is shown and the customer can try again', () => {
    expect(summarize([attempt('FAILED', 30, { statusDesc: 'Insufficient balance' })])).toMatchObject({
      state: 'UNPAID',
      canPay: true,
      message: 'Insufficient balance',
    });
  });

  test('any completed attempt means paid, even behind a newer one', () => {
    const paid = attempt('COMPLETED', 300, { completedAt: new Date(now.getTime() - 290_000), ft: { cbsReference: 'FT25290AAAAA' } });
    expect(summarize([attempt('FAILED', 30), paid])).toMatchObject({
      state: 'PAID',
      canPay: false,
      cbsReference: 'FT25290AAAAA',
      paidAt: '2026-10-21T09:55:10.000Z',
    });
  });

  test('an unanswered prompt behind a newer failed one still means "maybe paid"', () => {
    // refi98b4jjl5 was approved but never confirmed; the resend after it was rejected by the bank.
    const summary = summarize([attempt('FAILED', 30, { statusDesc: 'schema error' }), attempt('AWAITING_PIN', 1800)]);
    expect(summary).toMatchObject({ state: 'AWAITING_PIN', canPay: true, promptSentAt: '2026-10-21T09:30:00.000Z' });
  });

  test('a payment under review blocks paying again', () => {
    expect(summarize([attempt('FAILED', 10), attempt('PROCESSING', 120)])).toMatchObject({ state: 'PROCESSING', canPay: false });
  });
});
