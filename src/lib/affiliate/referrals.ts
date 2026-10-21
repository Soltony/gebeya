/**
 * Referral capture: a customer enters an affiliate's code in the mini-app.
 * The referral locks the program version that is current at that moment.
 */
import { startOfDay } from 'date-fns';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { getPhoneNumbersForAccount } from '@/lib/account-utils';
import { REFERRAL_CODE_PATTERN, normalizeReferralCode, readStoredConfig, type ProgramConfig } from './config';
import { shortPersonName } from './earn-rules';
import { isUniqueViolation } from './db';
import { AffiliateError, loadProgramRuntimes } from './programs';
import { takeBackCommission } from './commissions';

const INVALID_CODE = 'This code is not valid. Please check it and try again.';
const NOT_ACCEPTING = 'This code is not accepting new customers right now.';

async function isNewCustomer(phones: string[]) {
  const [loans, orders] = await Promise.all([
    prisma.loan.count({ where: { borrowerId: { in: phones } } }),
    prisma.order.count({ where: { borrowerId: { in: phones }, status: { not: 'CANCELLED' } } }),
  ]);
  return loans === 0 && orders === 0;
}

export const acceptsCodes = (config: ProgramConfig | null) => !!config && config.attribution.channels.includes('CODE');

/** Customers who joined themselves are shown to their friends by first name and initial only. */
const nameForFriends = (affiliate: { name: string; source: string }) =>
  affiliate.source === 'SELF' ? shortPersonName(affiliate.name) : affiliate.name;

export type ReferralStatus = {
  referred: boolean;
  affiliateName: string | null;
  canEnterCode: boolean;
};

/** What the mini-app shows: the referral already made, or whether a code can still be entered. */
export async function getReferralStatus(borrowerId: string): Promise<ReferralStatus> {
  const phones = await getPhoneNumbersForAccount(borrowerId);
  const referral = await prisma.affiliateReferral.findFirst({
    where: { borrowerId: { in: phones } },
    select: { affiliate: { select: { name: true, source: true } } },
  });
  if (referral) return { referred: true, affiliateName: nameForFriends(referral.affiliate), canEnterCode: false };

  const runtimes = await loadProgramRuntimes();
  const open = Array.from(runtimes.values()).filter((r) => r.status === 'ACTIVE' && acceptsCodes(r.currentConfig));
  if (!open.length) return { referred: false, affiliateName: null, canEnterCode: false };
  if (open.some((r) => !r.currentConfig!.attribution.newCustomersOnly)) {
    return { referred: false, affiliateName: null, canEnterCode: true };
  }
  return { referred: false, affiliateName: null, canEnterCode: await isNewCustomer(phones) };
}

/** Records the referral, or throws an AffiliateError with a message for the customer. */
export async function applyReferralCode(borrowerId: string, rawCode: string) {
  const code = normalizeReferralCode(rawCode);
  if (!REFERRAL_CODE_PATTERN.test(code)) throw new AffiliateError(INVALID_CODE, 400);

  const phones = await getPhoneNumbersForAccount(borrowerId);
  const already = await prisma.affiliateReferral.findFirst({ where: { borrowerId: { in: phones } }, select: { id: true } });
  if (already) throw new AffiliateError('You have already used a referral code.', 409);

  const affiliate = await prisma.affiliate.findUnique({ where: { code }, include: { program: true } });
  if (!affiliate || affiliate.status !== 'ACTIVE') throw new AffiliateError(INVALID_CODE, 404);

  const program = affiliate.program;
  if (program.status !== 'ACTIVE') throw new AffiliateError(NOT_ACCEPTING, 409);
  const version = await prisma.affiliateProgramVersion.findUnique({
    where: { programId_version: { programId: program.id, version: program.currentVersion } },
  });
  if (!version) throw new AffiliateError(NOT_ACCEPTING, 409);
  const config = readStoredConfig(version.config);
  if (!acceptsCodes(config)) throw new AffiliateError(NOT_ACCEPTING, 409);

  // Self-referral: the same person behind both phone numbers, or the payout
  // going to one of the customer's own accounts.
  const affiliatePhones = await getPhoneNumbersForAccount(affiliate.phoneNumber);
  const customerAccounts = await prisma.phoneAccount.findMany({
    where: { phoneNumber: { in: phones } },
    select: { accountNumber: true },
  });
  const ownAccount = !!affiliate.payoutAccount && customerAccounts.some((a) => a.accountNumber === affiliate.payoutAccount);
  if (ownAccount || affiliatePhones.some((p) => phones.includes(p))) {
    throw new AffiliateError("You can't use your own referral code.", 403);
  }

  if (config.attribution.newCustomersOnly && !(await isNewCustomer(phones))) {
    throw new AffiliateError('This code is only for new customers.', 403);
  }

  const dailyLimit = config.attribution.maxReferralsPerAffiliatePerDay;
  if (dailyLimit) {
    const today = await prisma.affiliateReferral.count({
      where: { affiliateId: affiliate.id, attributedAt: { gte: startOfDay(new Date()) } },
    });
    if (today >= dailyLimit) {
      throw new AffiliateError('This code has reached its limit for today. Please try again tomorrow.', 429);
    }
  }

  // Commission queries and payouts look borrowers up by id.
  await prisma.borrower.upsert({ where: { id: borrowerId }, update: {}, create: { id: borrowerId } });

  let referral;
  try {
    referral = await prisma.affiliateReferral.create({
      data: { affiliateId: affiliate.id, programVersionId: version.id, borrowerId, source: 'CODE', status: 'ACTIVE' },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AffiliateError('You have already used a referral code.', 409);
    throw error;
  }

  await createAuditLog({
    actorId: borrowerId,
    action: 'AFFILIATE_REFERRAL_CREATED',
    entity: 'AffiliateReferral',
    entityId: referral.id,
    details: { affiliateId: affiliate.id, code, programId: program.id, programVersion: version.version },
  });

  return { affiliateName: nameForFriends(affiliate) };
}

/** Rejects a referral (e.g. fraud) and takes back everything it earned. */
export async function rejectReferral(referralId: string, reason: string, actorId: string) {
  const now = new Date();
  const res = await prisma.affiliateReferral.updateMany({
    where: { id: referralId, status: 'ACTIVE' },
    data: { status: 'REJECTED', rejectedReason: reason, rejectedAt: now, rejectedById: actorId },
  });
  if (res.count === 0) throw new AffiliateError('Only an active referral can be rejected.', 409);

  const earned = await prisma.affiliateCommission.findMany({
    where: { referralId, kind: 'EARNED', status: { not: 'REVERSED' } },
    select: { id: true },
  });
  let takenBack = 0;
  for (const c of earned) {
    if (await takeBackCommission(c.id, `Referral rejected: ${reason}`, now)) takenBack++;
  }

  await createAuditLog({
    actorId,
    action: 'AFFILIATE_REFERRAL_REJECTED',
    entity: 'AffiliateReferral',
    entityId: referralId,
    details: { reason, commissionsTakenBack: takenBack },
  });
  return { takenBack };
}
