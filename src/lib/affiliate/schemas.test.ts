import { describe, expect, test } from 'vitest';
import { affiliateCreateSchema, affiliateUpdateSchema, normalizePhone } from './schemas';

const validAgent = {
  name: 'Abebe Kebede',
  phoneNumber: '0911223344',
  type: 'AGENT',
  programId: 'prog-1',
  payoutAccount: '1000123456789',
};

describe('normalizePhone', () => {
  test('brings Ethiopian mobile numbers to the borrower id format', () => {
    expect(normalizePhone('0911223344')).toBe('251911223344');
    expect(normalizePhone('+251 911 223 344')).toBe('251911223344');
    expect(normalizePhone('911223344')).toBe('251911223344');
    expect(normalizePhone('0711223344')).toBe('251711223344');
  });

  test('rejects numbers that are too short', () => {
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('affiliateCreateSchema', () => {
  test('accepts an agent with a payout account', () => {
    const parsed = affiliateCreateSchema.parse(validAgent);
    expect(parsed.phoneNumber).toBe('251911223344');
    expect(parsed.email).toBeUndefined();
  });

  test('requires a payout account for everyone except borrowers', () => {
    expect(affiliateCreateSchema.safeParse({ ...validAgent, payoutAccount: '' }).success).toBe(false);
    expect(affiliateCreateSchema.safeParse({ ...validAgent, type: 'BORROWER', payoutAccount: '' }).success).toBe(true);
  });

  test('treats an empty email as no email', () => {
    expect(affiliateCreateSchema.parse({ ...validAgent, email: '' }).email).toBeNull();
    expect(affiliateCreateSchema.safeParse({ ...validAgent, email: 'not-an-email' }).success).toBe(false);
  });
});

describe('affiliateUpdateSchema', () => {
  test('a field that is not sent stays undefined, so the update leaves it alone', () => {
    const parsed = affiliateUpdateSchema.parse({ name: 'New Name' });
    expect(parsed.payoutAccount).toBeUndefined();
    expect(parsed.email).toBeUndefined();
  });

  test('an empty payout account clears it', () => {
    expect(affiliateUpdateSchema.parse({ payoutAccount: '' }).payoutAccount).toBeNull();
  });
});
