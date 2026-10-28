/**
 * Who a mini-app user is in the affiliate program: their affiliate record, if
 * any, and the commissions and payouts that are their money. Shared by the Earn
 * page and self-service withdrawals so both always agree.
 */
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';

/** The affiliate behind any of the person's phone numbers, active ones first. */
export async function findAffiliateForPhones(phones: string[]) {
  return prisma.affiliate.findFirst({
    where: { phoneNumber: { in: phones } },
    orderBy: { status: 'asc' }, // ACTIVE before SUSPENDED
  });
}

/** Commissions that are the person's money: earned as an affiliate, or welcome bonuses for using a code. */
export function ownCommissions(affiliateId: string | null, phones: string[]): Prisma.AffiliateCommissionWhereInput {
  return {
    OR: [
      ...(affiliateId ? [{ beneficiary: 'AFFILIATE', affiliateId }] : []),
      { beneficiary: 'CUSTOMER', beneficiaryPhone: { in: phones } },
    ],
  };
}

/**
 * Points rows that are the person's: earned as an affiliate (affiliateId), as
 * a referred customer, or adjusted by an admin (both by phone).
 */
export function ownPoints(affiliateId: string | null, phones: string[]): Prisma.AffiliatePointTransactionWhereInput {
  return { OR: [{ phone: { in: phones } }, ...(affiliateId ? [{ affiliateId }] : [])] };
}

/** Payouts made to the person, for the same two reasons. */
export function ownPayouts(affiliateId: string | null, phones: string[]): Prisma.AffiliatePayoutWhereInput {
  return {
    OR: [
      ...(affiliateId ? [{ beneficiary: 'AFFILIATE', affiliateId }] : []),
      { beneficiary: 'CUSTOMER', beneficiaryPhone: { in: phones } },
    ],
  };
}
