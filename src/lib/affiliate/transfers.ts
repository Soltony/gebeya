/**
 * Using points: paying for a shop order, repaying a loan, or withdrawing.
 * Every use is an AffiliateTransfer paid from the Affiliate Program account:
 *
 * 1. Reserve, in one database transaction: the customer's points are taken
 *    (REDEEM row) and the Birr they buy is held on the affiliate account. A
 *    per-customer database lock serializes this, so the same points can never
 *    be spent twice; limits and both balances are checked under that lock.
 * 2. Send: CBS debits the affiliate account and credits the merchant, the loan
 *    provider's repayment account, or the customer's own account.
 * 3. Settle, in one transaction: the hold becomes a debit entry on the account
 *    and the purpose is completed (for a repayment, the loan repayment is
 *    recorded through the same function the payment gateway uses).
 *
 * A transfer that is called off before money moves returns the points (REFUND
 * row) and releases the hold. A failed CBS call is never retried on its own:
 * the bank may still have paid it, so an admin checks first and then retries,
 * confirms it as paid, or releases it.
 *
 * Each request carries an id from the app (or the order id), so repeating it
 * returns the same transfer instead of spending again.
 */
import { format, startOfDay, startOfMonth, subMinutes } from 'date-fns';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { createAuditLog } from '@/lib/audit-log';
import { getPhoneNumbersForAccount } from '@/lib/account-utils';
import { areDisbursementsEnabled } from '@/lib/disbursement-control';
import { getAsOfDate } from '@/lib/date-utils';
import { ensureInstallmentRollover } from '@/lib/installment-rollover';
import { computeActiveInstallmentDue, computeLoanLevelDue, MONEY_EPSILON } from '@/lib/repayment-due';
import { applyBnplRepayment } from '@/lib/bnpl-repayment';
import { OrderPricingError, priceOrderItems, toOrderItemsCreate, type OrderLineInput } from '@/lib/marketplace/order-pricing';
import { birrPerPoint, formatMoney, formatPoints, type PointUse, type PointsSettings } from './config';
import { birrForPoints, pointsNeeded, pointsUseProblem } from './earn-rules';
import { roundMoney } from './engine';
import { cbsTransfer } from './cbs';
import { debitReserved, getAccountState, releaseFunds, reserveFunds } from './account';
import { isUniqueViolation } from './db';
import { findAffiliateForPhones, ownPoints } from './people';
import { getPointsSettings, postPoints } from './points';
import { activeAccountForPhone } from './payouts';
import { AffiliateError, generateCode } from './programs';
import { normalizePhone } from './schemas';

type Tx = Prisma.TransactionClient;

export const TRANSFER_PURPOSES = ['SHOP', 'REPAYMENT', 'WITHDRAWAL'] as const;
export type TransferPurpose = (typeof TRANSFER_PURPOSES)[number];

export const TRANSFER_STATUSES = [
  'RESERVED', // shop order placed; paid when the customer confirms delivery
  'PENDING_REVIEW', // withdrawal above the automatic limit, waiting for a checker
  'READY', // approved, waiting to be sent
  'SENDING',
  'SUCCESS',
  'FAILED', // CBS refused or did not answer; an admin checks with the bank
  'SENT_UNAPPLIED', // the bank paid but the repayment could not be recorded
  'CANCELLED', // points returned
] as const;

const USE: Record<TransferPurpose, PointUse> = { SHOP: 'shop', REPAYMENT: 'repayment', WITHDRAWAL: 'withdrawal' };
const LABEL: Record<TransferPurpose, string> = {
  SHOP: 'Shop order paid with points',
  REPAYMENT: 'Loan repayment paid with points',
  WITHDRAWAL: 'Points withdrawn to own account',
};

/** A transfer stuck in SENDING this long (e.g. a restart mid-call) can be handled by an admin. */
const STALE_SENDING_MINUTES = 10;
const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

export function newTransferReference(now = new Date()): string {
  return `AFT-${format(now, 'yyMMdd')}-${generateCode(8)}`;
}

const maskAccount = (account: string) => `••••${account.slice(-4)}`;

/** The affiliate account could not hold the amount (frozen or not enough funds). */
class AccountUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// The person spending
// ---------------------------------------------------------------------------

async function personFor(borrowerId: string) {
  const phones = await getPhoneNumbersForAccount(borrowerId);
  const affiliate = await findAffiliateForPhones(phones);
  return {
    borrowerId,
    phones,
    affiliate,
    // The same key for every phone of one person, so their requests queue on one lock.
    lockKey: [...phones].sort()[0] ?? borrowerId,
    pointsWhere: ownPoints(affiliate?.id ?? null, phones),
  };
}

type Person = Awaited<ReturnType<typeof personFor>>;

function assertCanSpend(person: Person) {
  if (person.affiliate && person.affiliate.status !== 'ACTIVE') {
    throw new AffiliateError('Your points are on hold while the bank reviews your account.', 403);
  }
}

/** Serializes point spending per person: a SQL Server lock held until the transaction ends. */
async function lockWallet(tx: Tx, key: string) {
  const rows = await tx.$queryRaw<Array<{ result: number }>>`
    DECLARE @result int;
    EXEC @result = sp_getapplock @Resource = ${`affiliate-points:${key}`}, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
    SELECT @result AS result;`;
  if (!rows.length || rows[0].result < 0) {
    throw new AffiliateError('Your points are busy with another request. Please try again.', 409);
  }
}

async function pointsUsed(tx: Tx | typeof prisma, phones: string[], purpose: TransferPurpose, now: Date) {
  const rows = await tx.affiliateTransfer.findMany({
    where: { phone: { in: phones }, purpose, status: { not: 'CANCELLED' }, createdAt: { gte: startOfMonth(now) } },
    select: { points: true, createdAt: true },
  });
  const dayStart = startOfDay(now);
  return {
    today: rows.filter((r) => r.createdAt >= dayStart).reduce((sum, r) => sum + r.points, 0),
    month: rows.reduce((sum, r) => sum + r.points, 0),
  };
}

// ---------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------

type ReserveInput = {
  purpose: TransferPurpose;
  person: Person;
  points: number;
  pointValue: number;
  amount: number;
  creditAccount: string;
  creditAccountName?: string | null;
  orderId?: string | null;
  loanId?: string | null;
  idempotencyKey: string;
  status: 'RESERVED' | 'PENDING_REVIEW' | 'READY';
};

async function reserveWithin(tx: Tx, settings: PointsSettings, input: ReserveInput) {
  const { person } = input;
  await lockWallet(tx, person.lockKey);
  const balance = (await tx.affiliatePointTransaction.aggregate({ where: person.pointsWhere, _sum: { points: true } }))._sum.points ?? 0;
  const used = await pointsUsed(tx, person.phones, input.purpose, new Date());
  const problem = pointsUseProblem(settings[USE[input.purpose]], {
    points: input.points,
    balance,
    usedToday: used.today,
    usedThisMonth: used.month,
  });
  if (problem) throw new AffiliateError(problem, 409);
  if (!(await reserveFunds(tx, input.amount))) throw new AccountUnavailableError();

  const transfer = await tx.affiliateTransfer.create({
    data: {
      reference: newTransferReference(),
      idempotencyKey: input.idempotencyKey,
      purpose: input.purpose,
      status: input.status,
      phone: person.borrowerId,
      affiliateId: person.affiliate?.id ?? null,
      points: input.points,
      pointValue: input.pointValue,
      amount: roundMoney(input.amount),
      creditAccount: input.creditAccount,
      creditAccountName: input.creditAccountName ?? null,
      orderId: input.orderId ?? null,
      loanId: input.loanId ?? null,
    },
  });
  await postPoints(tx, {
    idempotencyKey: `REDEEM:${transfer.id}`,
    phone: person.borrowerId,
    affiliateId: person.affiliate?.id ?? null,
    type: 'REDEEM',
    points: -input.points,
    birrValue: -input.amount,
    note: `${LABEL[input.purpose]} (${transfer.reference})`,
  });
  return transfer;
}

type Transfer = Prisma.AffiliateTransferGetPayload<object>;

/**
 * Runs `work` (which reserves) in one transaction. A repeated request finds the
 * transfer it already made instead of spending again.
 */
async function reserveOnce(idempotencyKey: string, purpose: TransferPurpose, work: (tx: Tx) => Promise<Transfer>) {
  const existing = await prisma.affiliateTransfer.findUnique({ where: { idempotencyKey } });
  if (existing) return { transfer: existing, duplicate: true };
  try {
    const transfer = await prisma.$transaction(work, TRANSACTION_OPTIONS);
    await createAuditLog({
      actorId: transfer.phone,
      action: 'AFFILIATE_TRANSFER_RESERVED',
      entity: 'AffiliateTransfer',
      entityId: transfer.id,
      details: { purpose, reference: transfer.reference, points: transfer.points, amount: transfer.amount, status: transfer.status },
    });
    return { transfer, duplicate: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await prisma.affiliateTransfer.findUnique({ where: { idempotencyKey } });
      if (raced) return { transfer: raced, duplicate: true };
    }
    if (error instanceof AccountUnavailableError) {
      const account = await getAccountState();
      await createAuditLog({
        actorId: 'system',
        action: 'AFFILIATE_ACCOUNT_SHORT',
        entity: 'AffiliateAccount',
        entityId: account.id,
        details: { purpose, status: account.status, available: account.available },
      });
      throw new AffiliateError('Paying with points is not available right now. Please try again later.', 503);
    }
    throw error;
  }
}

export type TransferSummary = {
  id: string;
  reference: string;
  purpose: TransferPurpose;
  status: string;
  points: number;
  amount: number;
  account: string;
  createdAt: string;
  completedAt: string | null;
};

export function summarizeTransfer(t: Transfer): TransferSummary {
  return {
    id: t.id,
    reference: t.reference,
    purpose: t.purpose as TransferPurpose,
    status: t.status,
    points: t.points,
    amount: t.amount,
    account: maskAccount(t.creditAccount),
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Send and settle
// ---------------------------------------------------------------------------

export type TransferOutcome = { status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'SENT_UNAPPLIED'; message: string };

async function recordRepayment(tx: Tx, transfer: Transfer, bankReference: string) {
  if (!transfer.loanId) throw new AffiliateError('This repayment has no loan.');
  const loan = await tx.loan.findUnique({
    where: { id: transfer.loanId },
    include: { product: { include: { provider: { include: { ledgerAccounts: true } } } }, payments: { orderBy: { date: 'asc' } } },
  });
  if (!loan) throw new AffiliateError('The loan was not found.');
  const taxConfigs = await tx.tax.findMany({ where: { status: 'ACTIVE' } });
  const result = await applyBnplRepayment(tx, {
    loan: loan as never,
    taxConfigs,
    paymentAmount: transfer.amount,
    paymentDate: getAsOfDate(),
    // Ends with the bank reference so the Repayments report shows it.
    describeJournal: (installmentNumber) =>
      `Points repayment ${transfer.reference}${installmentNumber ? ` for installment ${installmentNumber}` : ''} of loan ${loan.id} from the affiliate account (FT: ${bankReference})`,
    auditActorId: transfer.phone,
    auditDetails: { affiliateTransferId: transfer.id, reference: transfer.reference, points: transfer.points, bankReference },
    logLabel: '[POINTS_REPAYMENT]',
    logId: transfer.id,
  });
  if (result.outcome === 'OVERPAYMENT') {
    throw new AffiliateError(`${formatMoney(transfer.amount)} is more than the ${result.scope} balance due (${formatMoney(result.due)}).`);
  }
  const journal = await tx.journalEntry.findFirst({
    where: { loanId: loan.id, description: { contains: transfer.reference } },
    orderBy: { id: 'desc' },
    select: { id: true, payment: { select: { id: true } } },
  });
  return { paymentId: journal?.payment?.id ?? null, journalEntryId: journal?.id ?? null };
}

/** The bank paid: debit the account and complete the purpose, all in one transaction. */
async function settleTransfer(
  transferId: string,
  bank: { transactionId: string | null; statusCode?: number | null; requestPayload?: string | null; responsePayload?: string | null },
  fromStatuses: string[],
  actorId: string
): Promise<TransferOutcome> {
  const transfer = await prisma.affiliateTransfer.findUnique({ where: { id: transferId } });
  if (!transfer) return { status: 'SKIPPED', message: 'Transfer not found.' };
  const bankReference = bank.transactionId ?? transfer.reference;
  const now = new Date();
  const entry = {
    idempotencyKey: `TRANSFER:${transfer.id}`,
    type: transfer.purpose as 'SHOP' | 'REPAYMENT' | 'WITHDRAWAL',
    amount: transfer.amount,
    counterpartyAccount: transfer.creditAccount,
    bankReference,
    transferId: transfer.id,
    description: `${LABEL[transfer.purpose as TransferPurpose]} ${transfer.reference}: ${formatPoints(transfer.points)} to ${transfer.creditAccount}${transfer.orderId ? ` for order ${transfer.orderId}` : ''}${transfer.loanId ? ` for loan ${transfer.loanId}` : ''}`,
  };
  const bankFields = {
    transactionId: bank.transactionId,
    statusCode: bank.statusCode ?? null,
    ...(bank.requestPayload !== undefined ? { requestPayload: bank.requestPayload } : {}),
    ...(bank.responsePayload !== undefined ? { responsePayload: bank.responsePayload } : {}),
  };

  try {
    const settled = await prisma.$transaction(async (tx) => {
      const claim = await tx.affiliateTransfer.updateMany({
        where: { id: transfer.id, status: { in: fromStatuses } },
        data: { status: 'SUCCESS', completedAt: now, errorMessage: null, ...bankFields },
      });
      if (claim.count === 0) return false;
      await debitReserved(tx, entry);
      if (transfer.purpose === 'REPAYMENT') {
        const posted = await recordRepayment(tx, transfer, bankReference);
        await tx.affiliateTransfer.update({ where: { id: transfer.id }, data: posted });
      }
      return true;
    }, TRANSACTION_OPTIONS);
    if (!settled) return { status: 'SKIPPED', message: 'This transfer was already settled.' };
  } catch (error) {
    // The money left the account but the purpose could not be completed (for
    // example the loan was repaid meanwhile): book the debit and hand it to an admin.
    const message = error instanceof Error ? error.message : String(error);
    const booked = await prisma.$transaction(async (tx) => {
      const claim = await tx.affiliateTransfer.updateMany({
        where: { id: transfer.id, status: { in: fromStatuses } },
        data: { status: 'SENT_UNAPPLIED', completedAt: now, errorMessage: `Paid by the bank, not recorded: ${message}`, ...bankFields },
      });
      if (claim.count === 0) return false;
      await debitReserved(tx, entry);
      return true;
    }, TRANSACTION_OPTIONS);
    logger.error(`[affiliate] transfer ${transfer.id} paid but not applied: ${message}`);
    await createAuditLog({
      actorId,
      action: 'AFFILIATE_TRANSFER_NOT_APPLIED',
      entity: 'AffiliateTransfer',
      entityId: transfer.id,
      details: { reference: transfer.reference, bankReference, error: message },
    });
    return booked
      ? { status: 'SENT_UNAPPLIED', message: 'The bank paid it, but it could not be recorded. An admin will finish it.' }
      : { status: 'SKIPPED', message: 'This transfer was already settled.' };
  }

  await createAuditLog({
    actorId,
    action: 'AFFILIATE_TRANSFER_PAID',
    entity: 'AffiliateTransfer',
    entityId: transfer.id,
    details: { purpose: transfer.purpose, reference: transfer.reference, amount: transfer.amount, creditAccount: transfer.creditAccount, bankReference },
  });
  return { status: 'SUCCESS', message: 'Paid.' };
}

/** Sends one transfer through CBS. `retry` re-sends a FAILED (or stuck) one; only an admin passes it. */
export async function sendTransfer(transferId: string, options: { retry?: boolean; actorId?: string } = {}): Promise<TransferOutcome> {
  if (!(await areDisbursementsEnabled())) return { status: 'SKIPPED', message: 'Disbursements are currently disabled.' };
  const account = await getAccountState();
  if (account.status !== 'ACTIVE') return { status: 'SKIPPED', message: 'The affiliate account is frozen.' };

  const now = new Date();
  const claim = await prisma.affiliateTransfer.updateMany({
    where: options.retry
      ? { id: transferId, OR: [{ status: 'FAILED' }, { status: 'SENDING', lastAttemptAt: { lt: subMinutes(now, STALE_SENDING_MINUTES) } }] }
      : { id: transferId, status: 'READY' },
    data: { status: 'SENDING', attempts: { increment: 1 }, lastAttemptAt: now, errorMessage: null, cbsProviderId: account.effectiveCbsProviderId },
  });
  if (claim.count === 0) return { status: 'SKIPPED', message: 'This transfer is not ready to be sent.' };
  const transfer = await prisma.affiliateTransfer.findUniqueOrThrow({ where: { id: transferId } });

  const result = await cbsTransfer({
    creditAccount: transfer.creditAccount,
    amount: transfer.amount,
    providerId: account.effectiveCbsProviderId,
    audit: { actorId: options.actorId ?? 'system', integration: 'AFFILIATE_TRANSFER', entity: 'AffiliateTransfer', entityId: transfer.id },
  });

  if (!result.ok) {
    await prisma.affiliateTransfer.updateMany({
      where: { id: transfer.id, status: 'SENDING' },
      data: {
        status: 'FAILED',
        errorMessage: result.message,
        statusCode: result.statusCode,
        requestPayload: result.requestPayload,
        responsePayload: result.responsePayload,
      },
    });
    await createAuditLog({
      actorId: options.actorId ?? 'system',
      action: 'AFFILIATE_TRANSFER_FAILED',
      entity: 'AffiliateTransfer',
      entityId: transfer.id,
      details: { reference: transfer.reference, error: result.message },
    });
    return { status: 'FAILED', message: result.message };
  }

  return settleTransfer(
    transfer.id,
    { transactionId: result.transactionId, statusCode: result.statusCode, requestPayload: result.requestPayload, responsePayload: result.responsePayload },
    ['SENDING'],
    options.actorId ?? 'system'
  );
}

/** Calls a transfer off before money moved: the points come back and the hold is released. */
async function cancelTransfer(transferId: string, reason: string, actorId: string, fromStatuses: string[]): Promise<boolean> {
  const cancelled = await prisma.$transaction(async (tx) => {
    const transfer = await tx.affiliateTransfer.findUnique({ where: { id: transferId } });
    if (!transfer) return null;
    const claim = await tx.affiliateTransfer.updateMany({
      where: { id: transferId, status: { in: fromStatuses } },
      data: { status: 'CANCELLED', cancelReason: reason, completedAt: new Date() },
    });
    if (claim.count === 0) return null;
    await releaseFunds(tx, transfer.amount);
    await postPoints(tx, {
      idempotencyKey: `REFUND:${transfer.id}`,
      phone: transfer.phone,
      affiliateId: transfer.affiliateId,
      type: 'REFUND',
      points: transfer.points,
      birrValue: transfer.amount,
      note: `Points returned: ${reason} (${transfer.reference})`,
    });
    return transfer;
  }, TRANSACTION_OPTIONS);
  if (!cancelled) return false;
  await createAuditLog({
    actorId,
    action: 'AFFILIATE_TRANSFER_CANCELLED',
    entity: 'AffiliateTransfer',
    entityId: transferId,
    details: { reference: cancelled.reference, reason, pointsReturned: cancelled.points },
  });
  return true;
}

function sendLater(transferId: string, actorId?: string) {
  // Sent after the response, like approved payouts; anything left READY is
  // picked up by the worker.
  void sendTransfer(transferId, { actorId }).catch((error) =>
    logger.error(`[affiliate] sending transfer ${transferId} failed: ${String(error)}`)
  );
}

// ---------------------------------------------------------------------------
// The three uses
// ---------------------------------------------------------------------------

async function ownAccountFor(person: Person): Promise<string | null> {
  const affiliate = person.affiliate;
  if (affiliate && affiliate.type !== 'BORROWER' && affiliate.payoutAccount) return affiliate.payoutAccount;
  for (const phone of [person.borrowerId, ...person.phones.filter((p) => p !== person.borrowerId)]) {
    const account = await activeAccountForPhone(phone);
    if (account) return account;
  }
  return null;
}

function requireRequestId(requestId: string) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new AffiliateError('Invalid request. Please try again.');
}

/** Points to Birr, sent to the person's own account. Above the automatic limit a checker approves first. */
export async function requestPointsWithdrawal(borrowerId: string, input: { points: number; requestId: string }) {
  requireRequestId(input.requestId);
  const person = await personFor(borrowerId);
  assertCanSpend(person);
  const { settings } = await getPointsSettings();
  const rate = birrPerPoint(settings, 'withdrawal');
  const points = Math.floor(input.points);
  const amount = birrForPoints(points, rate);
  const creditAccount = await ownAccountFor(person);
  if (!creditAccount) throw new AffiliateError("We couldn't find an account linked to your phone. Please contact the bank.", 409);
  const review = amount > settings.withdrawal.autoApproveUpTo;

  const { transfer, duplicate } = await reserveOnce(`WITHDRAWAL:${borrowerId}:${input.requestId}`, 'WITHDRAWAL', (tx) =>
    reserveWithin(tx, settings, {
      purpose: 'WITHDRAWAL',
      person,
      points,
      pointValue: rate,
      amount,
      creditAccount,
      idempotencyKey: `WITHDRAWAL:${borrowerId}:${input.requestId}`,
      status: review ? 'PENDING_REVIEW' : 'READY',
    })
  );
  if (!duplicate && transfer.status === 'READY') sendLater(transfer.id, borrowerId);
  return summarizeTransfer(transfer);
}

/** What one loan needs right now: the active installment, or the loan when it has no schedule. */
export async function amountDueNow(loanId: string): Promise<number> {
  const asOfDate = getAsOfDate();
  await ensureInstallmentRollover(prisma, loanId, asOfDate);
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { product: { include: { provider: true } }, payments: { orderBy: { date: 'asc' } } },
  });
  if (!loan) return 0;
  const [installments, taxConfigs] = await Promise.all([
    prisma.loanInstallment.findMany({ where: { loanId }, orderBy: { installmentNumber: 'asc' } }),
    prisma.tax.findMany({ where: { status: 'ACTIVE' } }),
  ]);
  const activeDue = installments.length
    ? computeActiveInstallmentDue(loan as any, loan.product as any, taxConfigs as any, installments as any, asOfDate)
    : null;
  return roundMoney(activeDue ? activeDue.total : computeLoanLevelDue(loan as any, loan.product as any, taxConfigs as any, asOfDate));
}

/** Pays (part of) what a loan needs now with points; the provider's repayment account is credited. */
export async function requestPointsRepayment(borrowerId: string, input: { loanId: string; amount: number; requestId: string }) {
  requireRequestId(input.requestId);
  const person = await personFor(borrowerId);
  assertCanSpend(person);
  const { settings } = await getPointsSettings();
  const rate = birrPerPoint(settings, 'repayment');
  const amount = roundMoney(input.amount);
  if (!(amount > 0)) throw new AffiliateError('Enter an amount to pay.');

  const idempotencyKey = `REPAYMENT:${borrowerId}:${input.requestId}`;
  const existing = await prisma.affiliateTransfer.findUnique({ where: { idempotencyKey } });
  if (existing) return summarizeTransfer(existing);

  const loan = await prisma.loan.findUnique({
    where: { id: input.loanId },
    select: { id: true, borrowerId: true, repaymentStatus: true, product: { select: { name: true, provider: { select: { name: true, accountNumber: true } } } } },
  });
  if (!loan || !person.phones.includes(loan.borrowerId)) throw new AffiliateError('Loan not found.', 404);
  if (loan.repaymentStatus !== 'Unpaid') throw new AffiliateError('This loan is already repaid.', 409);
  const creditAccount = loan.product.provider.accountNumber;
  if (!creditAccount) throw new AffiliateError("This loan can't be repaid with points right now.", 409);
  const due = await amountDueNow(loan.id);
  if (amount > due + MONEY_EPSILON) throw new AffiliateError(`You can pay up to ${formatMoney(due)} now.`, 409);

  const { transfer, duplicate } = await reserveOnce(idempotencyKey, 'REPAYMENT', (tx) =>
    reserveWithin(tx, settings, {
      purpose: 'REPAYMENT',
      person,
      points: pointsNeeded(amount, rate),
      pointValue: rate,
      amount,
      creditAccount,
      creditAccountName: loan.product.provider.name,
      loanId: loan.id,
      idempotencyKey,
      status: 'READY',
    })
  );
  // Sent right away so the customer sees the result.
  if (!duplicate) await sendTransfer(transfer.id, { actorId: borrowerId });
  return summarizeTransfer(await prisma.affiliateTransfer.findUniqueOrThrow({ where: { id: transfer.id } }));
}

/**
 * Places a shop order paid entirely with points. The points are reserved now
 * and the merchant is paid when the customer confirms delivery with the code.
 */
export async function createPointsShopOrder(
  borrowerId: string,
  input: { merchantId: string; items: OrderLineInput[]; requestId: string }
) {
  requireRequestId(input.requestId);
  const person = await personFor(borrowerId);
  assertCanSpend(person);
  const { settings } = await getPointsSettings();
  if (!settings.shop.enabled) throw new AffiliateError('Paying with points is not available right now.', 409);

  const idempotencyKey = `SHOP:${borrowerId}:${input.requestId}`;
  const existing = await prisma.affiliateTransfer.findUnique({ where: { idempotencyKey } });
  if (existing) return { orderId: existing.orderId, transfer: summarizeTransfer(existing) };

  let priced;
  try {
    priced = await priceOrderItems(input.items);
  } catch (error) {
    if (error instanceof OrderPricingError) throw new AffiliateError(error.message, 400);
    throw error;
  }
  if (priced.lines.some((line) => line.item.merchantId !== input.merchantId)) {
    throw new AffiliateError('All items must come from the same shop.', 400);
  }
  if (!(priced.totalAmount > 0)) throw new AffiliateError('This order has nothing to pay.', 400);
  const merchant = await prisma.merchant.findUnique({ where: { id: input.merchantId }, select: { name: true, accountNumber: true } });
  if (!merchant?.accountNumber) throw new AffiliateError("This shop can't take points yet.", 409);

  const rate = birrPerPoint(settings, 'shop');
  await prisma.borrower.upsert({ where: { id: borrowerId }, update: {}, create: { id: borrowerId } });
  const { transfer } = await reserveOnce(idempotencyKey, 'SHOP', async (tx) => {
    const order = await tx.order.create({
      data: {
        borrowerId,
        merchantId: input.merchantId,
        totalAmount: priced.totalAmount,
        paymentType: 'POINTS',
        status: priced.requiresConfirmation ? 'PENDING_MERCHANT_CONFIRMATION' : 'ON_DELIVERY',
        orderItems: { create: toOrderItemsCreate(priced) },
      },
    });
    return reserveWithin(tx, settings, {
      purpose: 'SHOP',
      person,
      points: pointsNeeded(priced.totalAmount, rate),
      pointValue: rate,
      amount: priced.totalAmount,
      creditAccount: merchant.accountNumber!,
      creditAccountName: merchant.name,
      orderId: order.id,
      idempotencyKey,
      status: 'RESERVED',
    });
  });
  return { orderId: transfer.orderId, transfer: summarizeTransfer(transfer) };
}

/**
 * The customer confirms delivery of a points order with the code sent to
 * their phone: the code is used, the order becomes DELIVERED and the merchant
 * is paid, in one transaction (the payment itself is sent right after).
 */
export async function confirmPointsOrderDelivery(borrowerId: string, input: { orderId: string; code: string }) {
  const person = await personFor(borrowerId);
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, borrowerId: true, paymentType: true, status: true } });
  if (!order || order.paymentType !== 'POINTS' || !person.phones.includes(order.borrowerId)) {
    throw new AffiliateError('Order not found.', 404);
  }
  if (order.status !== 'ON_DELIVERY') throw new AffiliateError('This order is not out for delivery.', 409);
  const code = String(input.code ?? '').trim();
  if (!code) throw new AffiliateError('Enter the code we sent you.');

  const transferId = await prisma.$transaction(async (tx) => {
    const otp = await tx.deliveryOtp.findFirst({
      where: { orderId: order.id, code, verified: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new AffiliateError('Invalid or expired code.', 400);
    const used = await tx.deliveryOtp.updateMany({ where: { id: otp.id, verified: false }, data: { verified: true } });
    if (used.count !== 1) throw new AffiliateError('Invalid or expired code.', 400);
    const delivered = await tx.order.updateMany({ where: { id: order.id, status: 'ON_DELIVERY' }, data: { status: 'DELIVERED' } });
    if (delivered.count !== 1) throw new AffiliateError('This order is not out for delivery.', 409);
    const transfer = await tx.affiliateTransfer.findFirst({ where: { orderId: order.id, purpose: 'SHOP', status: 'RESERVED' } });
    if (!transfer) throw new AffiliateError('The points for this order are not reserved.', 409);
    await tx.affiliateTransfer.update({ where: { id: transfer.id }, data: { status: 'READY' } });
    return transfer.id;
  }, TRANSACTION_OPTIONS);

  await createAuditLog({ actorId: borrowerId, action: 'AFFILIATE_POINTS_ORDER_DELIVERED', entity: 'Order', entityId: order.id, details: { transferId } });
  sendLater(transferId, borrowerId);
  return { delivered: true };
}

/** A points order was cancelled (by the customer, the merchant or an admin): the points come back. */
export async function releasePointsOrder(orderId: string, reason: string, actorId: string) {
  const transfer = await prisma.affiliateTransfer.findFirst({ where: { orderId, purpose: 'SHOP', status: 'RESERVED' }, select: { id: true } });
  if (!transfer) return false;
  return cancelTransfer(transfer.id, reason, actorId, ['RESERVED']);
}

export type PointsUseOption = {
  enabled: boolean;
  /** ETB one point buys for this use. */
  rate: number;
  minPoints: number;
  /** Points still allowed today / this month; null = no limit. */
  leftToday: number | null;
  leftThisMonth: number | null;
};

export type PointsUseOptions = {
  shop: PointsUseOption;
  repayment: PointsUseOption & { loans: Array<{ id: string; label: string; due: number }> };
  withdrawal: PointsUseOption & { account: string | null; autoApproveUpTo: number };
  transfers: TransferSummary[];
};

/** What the Earn page offers for using points, for this person. */
export async function pointsUseOptions(borrowerId: string): Promise<PointsUseOptions> {
  const person = await personFor(borrowerId);
  const { settings } = await getPointsSettings();
  const now = new Date();
  const option = async (purpose: TransferPurpose): Promise<PointsUseOption> => {
    const s = settings[USE[purpose]];
    const used = await pointsUsed(prisma, person.phones, purpose, now);
    return {
      enabled: s.enabled,
      rate: birrPerPoint(settings, USE[purpose]),
      minPoints: s.minPoints,
      leftToday: s.maxPointsPerDay != null ? Math.max(0, s.maxPointsPerDay - used.today) : null,
      leftThisMonth: s.maxPointsPerMonth != null ? Math.max(0, s.maxPointsPerMonth - used.month) : null,
    };
  };
  const [shop, repayment, withdrawal, recent] = await Promise.all([
    option('SHOP'),
    option('REPAYMENT'),
    option('WITHDRAWAL'),
    prisma.affiliateTransfer.findMany({ where: { phone: { in: person.phones } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const loans: Array<{ id: string; label: string; due: number }> = [];
  if (repayment.enabled) {
    const unpaid = await prisma.loan.findMany({
      where: { borrowerId: { in: person.phones }, repaymentStatus: 'Unpaid' },
      select: { id: true, loanAmount: true, product: { select: { name: true, provider: { select: { name: true, accountNumber: true } } } } },
      orderBy: { dueDate: 'asc' },
      take: 10,
    });
    for (const loan of unpaid) {
      if (!loan.product.provider.accountNumber) continue;
      const due = await amountDueNow(loan.id);
      if (due > 0) loans.push({ id: loan.id, label: `${loan.product.provider.name} · ${loan.product.name} (${formatMoney(loan.loanAmount)})`, due });
    }
  }
  const account = withdrawal.enabled ? await ownAccountFor(person) : null;

  return {
    shop,
    repayment: { ...repayment, loans },
    withdrawal: { ...withdrawal, account: account ? maskAccount(account) : null, autoApproveUpTo: settings.withdrawal.autoApproveUpTo },
    transfers: recent.map(summarizeTransfer),
  };
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

type Reviewer = { id: string; phoneNumber?: string | null };

async function assertNotOwn(transfer: Transfer, reviewer: Reviewer) {
  const reviewerPhone = reviewer.phoneNumber ? normalizePhone(reviewer.phoneNumber) : null;
  if (!reviewerPhone) return;
  const theirs = await getPhoneNumbersForAccount(transfer.phone);
  if (theirs.some((phone) => normalizePhone(phone) === reviewerPhone)) {
    throw new AffiliateError("You can't act on your own points.", 403);
  }
}

async function loadTransfer(id: string) {
  const transfer = await prisma.affiliateTransfer.findUnique({ where: { id } });
  if (!transfer) throw new AffiliateError('Transfer not found.', 404);
  return transfer;
}

/** Checker approves a withdrawal above the automatic limit. */
export async function approveTransfer(id: string, reviewer: Reviewer) {
  const transfer = await loadTransfer(id);
  await assertNotOwn(transfer, reviewer);
  const res = await prisma.affiliateTransfer.updateMany({
    where: { id, status: 'PENDING_REVIEW' },
    data: { status: 'READY', reviewedById: reviewer.id, reviewedAt: new Date() },
  });
  if (res.count === 0) throw new AffiliateError('This transfer is no longer waiting for review.', 409);
  await createAuditLog({ actorId: reviewer.id, action: 'AFFILIATE_TRANSFER_APPROVED', entity: 'AffiliateTransfer', entityId: id, details: { reference: transfer.reference } });
  sendLater(id, reviewer.id);
}

/** Checker declines: nothing is paid and the points come back. */
export async function declineTransfer(id: string, reviewer: Reviewer, reason: string) {
  const transfer = await loadTransfer(id);
  await assertNotOwn(transfer, reviewer);
  await prisma.affiliateTransfer.updateMany({ where: { id, status: 'PENDING_REVIEW' }, data: { reviewedById: reviewer.id, reviewedAt: new Date() } });
  if (!(await cancelTransfer(id, `Declined: ${reason}`, reviewer.id, ['PENDING_REVIEW']))) {
    throw new AffiliateError('This transfer is no longer waiting for review.', 409);
  }
}

const isStuck = (t: Transfer) =>
  t.status === 'SENDING' && !!t.lastAttemptAt && t.lastAttemptAt < subMinutes(new Date(), STALE_SENDING_MINUTES);

/** After checking with the bank that it was NOT paid: send it again. */
export async function retryTransfer(id: string, actor: Reviewer) {
  const transfer = await loadTransfer(id);
  await assertNotOwn(transfer, actor);
  const outcome = await sendTransfer(id, { retry: true, actorId: actor.id });
  if (outcome.status === 'SKIPPED') throw new AffiliateError(outcome.message, 409);
  return outcome;
}

/** After checking with the bank that it WAS paid: settle it with the bank's reference. */
export async function confirmTransferPaid(id: string, actor: Reviewer, bankReference: string) {
  const transfer = await loadTransfer(id);
  await assertNotOwn(transfer, actor);
  if (transfer.status !== 'FAILED' && !isStuck(transfer)) throw new AffiliateError('Only a failed or stuck transfer can be confirmed.', 409);
  const outcome = await settleTransfer(id, { transactionId: bankReference.trim() }, ['FAILED', 'SENDING'], actor.id);
  await createAuditLog({ actorId: actor.id, action: 'AFFILIATE_TRANSFER_CONFIRMED_PAID', entity: 'AffiliateTransfer', entityId: id, details: { bankReference, outcome: outcome.status } });
  return outcome;
}

/** After checking with the bank that it was NOT paid and should not be: the points come back. */
export async function releaseTransfer(id: string, actor: Reviewer, reason: string) {
  const transfer = await loadTransfer(id);
  await assertNotOwn(transfer, actor);
  // The customer already has the goods: the merchant must still be paid.
  if (transfer.purpose === 'SHOP') throw new AffiliateError('The customer received the order: retry the payment or confirm it as paid.', 409);
  const from = isStuck(transfer) ? ['SENDING'] : ['FAILED'];
  if (!(await cancelTransfer(id, `Released: ${reason}`, actor.id, from))) {
    throw new AffiliateError('Only a failed or stuck transfer can be released.', 409);
  }
}

/** A paid repayment that could not be recorded was finished by hand (e.g. a manual repayment). */
export async function resolveUnappliedTransfer(id: string, actor: Reviewer, note: string) {
  const transfer = await loadTransfer(id);
  const res = await prisma.affiliateTransfer.updateMany({
    where: { id, status: 'SENT_UNAPPLIED' },
    data: { status: 'SUCCESS', errorMessage: `${transfer.errorMessage ?? ''} Resolved by an admin: ${note}`.trim() },
  });
  if (res.count === 0) throw new AffiliateError('Only a paid but unrecorded transfer can be resolved.', 409);
  await createAuditLog({ actorId: actor.id, action: 'AFFILIATE_TRANSFER_RESOLVED', entity: 'AffiliateTransfer', entityId: id, details: { note } });
}

// ---------------------------------------------------------------------------
// Worker sweep
// ---------------------------------------------------------------------------

/** Returns points of cancelled orders (any cancel path) and sends approved transfers left waiting. */
export async function runTransferSweep() {
  const result = { released: 0, sent: 0, failed: 0 };
  const reserved = await prisma.affiliateTransfer.findMany({
    where: { purpose: 'SHOP', status: 'RESERVED', orderId: { not: null } },
    select: { id: true, orderId: true },
  });
  if (reserved.length) {
    const cancelled = new Set(
      (await prisma.order.findMany({ where: { id: { in: reserved.map((r) => r.orderId!) }, status: 'CANCELLED' }, select: { id: true } })).map((o) => o.id)
    );
    for (const r of reserved.filter((t) => cancelled.has(t.orderId!))) {
      if (await cancelTransfer(r.id, 'Order cancelled', 'system', ['RESERVED'])) result.released++;
    }
  }
  const ready = await prisma.affiliateTransfer.findMany({ where: { status: 'READY' }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  for (const t of ready) {
    const outcome = await sendTransfer(t.id).catch((error) => {
      logger.error(`[affiliate] transfer ${t.id} failed: ${String(error)}`);
      return { status: 'FAILED' as const, message: String(error) };
    });
    if (outcome.status === 'SUCCESS' || outcome.status === 'SENT_UNAPPLIED') result.sent++;
    else if (outcome.status === 'FAILED') result.failed++;
    else break; // disbursements off or the account frozen: leave the rest for later
  }
  if (result.released || result.sent || result.failed) {
    logger.info(`[affiliate] transfers released=${result.released} sent=${result.sent} failed=${result.failed}`);
  }
  return result;
}
