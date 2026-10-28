/**
 * Request payloads for program and affiliate changes. Validated when a maker
 * submits a request and again when a checker approves it.
 */
import { z } from 'zod';
import { AFFILIATE_TYPES } from './config';

/**
 * Normalizes an Ethiopian mobile number to the 2519XXXXXXXX / 2517XXXXXXXX
 * form borrowers are identified by. Other numbers are kept as digits.
 */
export function normalizePhone(input: string): string | null {
  const digits = String(input ?? '').replace(/\D/g, '');
  const local = /^(?:251|0)?([79]\d{8})$/.exec(digits);
  if (local) return `251${local[1]}`;
  if (digits.length >= 9 && digits.length <= 15) return digits;
  return null;
}

const programName = z.string().trim().min(2, 'Name is too short').max(120);
const optionalText = z.string().trim().max(2000).nullable().optional();

export const programCreateSchema = z.object({
  name: programName,
  description: optionalText,
  config: z.unknown(),
});

export const programUpdateSchema = z.object({
  name: programName.optional(),
  description: optionalText,
  config: z.unknown().optional(),
  status: z.literal('ACTIVE').optional(),
});

const phoneField = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return phone;
  });

const accountField = z
  .string()
  .trim()
  .max(34)
  .regex(/^[A-Za-z0-9]*$/, 'Account number can only contain letters and digits')
  .nullable()
  .optional()
  // Not sent: leave unchanged (undefined). Sent empty: clear it (null).
  .transform((value) => (value === undefined ? undefined : value || null));

const emailField = z
  .string()
  .trim()
  .email('Enter a valid email')
  .max(200)
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));

export const affiliateCreateSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(120),
    phoneNumber: phoneField,
    type: z.enum(AFFILIATE_TYPES),
    programId: z.string().min(1, 'Choose a program'),
    email: emailField,
    payoutAccount: accountField,
    code: z.string().trim().max(16).nullable().optional(),
  })
  // Only borrowers have a linked account to fall back on at payout time.
  .refine((a) => a.type === 'BORROWER' || !!a.payoutAccount, {
    path: ['payoutAccount'],
    message: 'A payout account is required (only borrowers can be paid into their linked account)',
  });

export const affiliateUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  type: z.enum(AFFILIATE_TYPES).optional(),
  programId: z.string().min(1).optional(),
  email: emailField,
  payoutAccount: accountField,
  status: z.literal('ACTIVE').optional(),
});

export type ProgramCreatePayload = z.infer<typeof programCreateSchema>;
export type AffiliateCreatePayload = z.infer<typeof affiliateCreateSchema>;
