/**
 * The Affiliate Program account: the one bank account every affiliate money
 * movement is paid from (shop orders, loan repayments and withdrawals paid
 * with points, and money payouts).
 *
 * It follows the provider ledgers: the balance is stored on the account and
 * only changes in the same database transaction that writes an entry, and
 * entries are never edited. Transfers first hold (reserve) their amount, so
 * two transfers can never spend the same Birr; the hold becomes a debit when
 * the bank confirms the transfer, or is released when it is called off.
 * Balance changes are single conditional UPDATEs, so they are safe under
 * concurrency without reading the balance first.
 *
 * Funding, adjustments, settings changes and unfreezing go through
 * maker-checker; freezing is immediate because it only stops spending.
 */
import { format } from 'date-fns';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { formatMoney } from './config';
import { defaultCbsProviderId } from './cbs';
import { isUniqueViolation } from './db';
import { roundMoney } from './engine';
import { AffiliateError, generateCode } from './programs';

type Tx = Prisma.TransactionClient;

export const AFFILIATE_ACCOUNT_ID = 'AFFILIATE_PROGRAM';

// Float sums can be off by a hair; never let that refuse an exact payment.
const EPSILON = 0.000001;

export type EntryType = 'FUNDING' | 'ADJUSTMENT' | 'SHOP' | 'REPAYMENT' | 'WITHDRAWAL' | 'PAYOUT';

export function newAccountReference(now = new Date()): string {
  return `AFA-${format(now, 'yyMMdd')}-${generateCode(8)}`;
}

/** The account, created with its defaults the first time it is needed. */
export async function getAffiliateAccount(db: Tx | typeof prisma = prisma) {
  return db.affiliateAccount.upsert({
    where: { id: AFFILIATE_ACCOUNT_ID },
    update: {},
    create: { id: AFFILIATE_ACCOUNT_ID, name: 'Affiliate Program', status: 'ACTIVE' },
  });
}

export type AccountState = Awaited<ReturnType<typeof getAffiliateAccount>> & {
  available: number;
  /** The provider id CBS debits: the account's own, or the default from the environment. */
  effectiveCbsProviderId: string;
};

export async function getAccountState(db: Tx | typeof prisma = prisma): Promise<AccountState> {
  const account = await getAffiliateAccount(db);
  return {
    ...account,
    available: roundMoney(account.balance - account.reserved),
    effectiveCbsProviderId: account.cbsProviderId || defaultCbsProviderId(),
  };
}

/**
 * Holds `amount` for a transfer. False when the account is frozen or its
 * available balance (balance minus what is already held) is too low.
 */
export async function reserveFunds(tx: Tx, amount: number): Promise<boolean> {
  await getAffiliateAccount(tx);
  const value = roundMoney(amount);
  if (value <= 0) return false;
  const updated = await tx.$executeRaw`
    UPDATE [dbo].[AffiliateAccount]
    SET [reserved] = [reserved] + ${value}, [updatedAt] = SYSUTCDATETIME()
    WHERE [id] = ${AFFILIATE_ACCOUNT_ID} AND [status] = 'ACTIVE' AND [balance] - [reserved] >= ${value - EPSILON}`;
  return updated === 1;
}

/** Gives back a hold that will not be spent. */
export async function releaseFunds(tx: Tx, amount: number): Promise<void> {
  const value = roundMoney(amount);
  if (value <= 0) return;
  await tx.$executeRaw`
    UPDATE [dbo].[AffiliateAccount]
    SET [reserved] = CASE WHEN [reserved] - ${value} < 0 THEN 0 ELSE [reserved] - ${value} END, [updatedAt] = SYSUTCDATETIME()
    WHERE [id] = ${AFFILIATE_ACCOUNT_ID}`;
}

type EntryInput = {
  idempotencyKey: string;
  type: EntryType;
  amount: number;
  description: string;
  counterpartyAccount?: string | null;
  bankReference?: string | null;
  transferId?: string | null;
  payoutId?: string | null;
  createdById?: string | null;
  approvedById?: string | null;
};

async function writeEntry(tx: Tx, direction: 'DEBIT' | 'CREDIT', input: EntryInput) {
  // Read after the update in the same transaction: the row stays locked, so
  // this is exactly the balance this movement produced.
  const account = await tx.affiliateAccount.findUniqueOrThrow({ where: { id: AFFILIATE_ACCOUNT_ID }, select: { balance: true } });
  return tx.affiliateAccountEntry.create({
    data: {
      accountId: AFFILIATE_ACCOUNT_ID,
      idempotencyKey: input.idempotencyKey,
      reference: newAccountReference(),
      type: input.type,
      direction,
      amount: roundMoney(input.amount),
      balanceAfter: roundMoney(account.balance),
      counterpartyAccount: input.counterpartyAccount ?? null,
      bankReference: input.bankReference ?? null,
      transferId: input.transferId ?? null,
      payoutId: input.payoutId ?? null,
      description: input.description,
      createdById: input.createdById ?? null,
      approvedById: input.approvedById ?? null,
    },
  });
}

/** The bank paid a transfer that held `amount`: the hold becomes a debit. */
export async function debitReserved(tx: Tx, input: EntryInput) {
  const value = roundMoney(input.amount);
  await tx.$executeRaw`
    UPDATE [dbo].[AffiliateAccount]
    SET [balance] = [balance] - ${value},
        [reserved] = CASE WHEN [reserved] - ${value} < 0 THEN 0 ELSE [reserved] - ${value} END,
        [updatedAt] = SYSUTCDATETIME()
    WHERE [id] = ${AFFILIATE_ACCOUNT_ID}`;
  return writeEntry(tx, 'DEBIT', input);
}

/** Money into the account (funding, or a credit adjustment). */
export async function creditAccount(tx: Tx, input: EntryInput) {
  await getAffiliateAccount(tx);
  const value = roundMoney(input.amount);
  await tx.$executeRaw`
    UPDATE [dbo].[AffiliateAccount] SET [balance] = [balance] + ${value}, [updatedAt] = SYSUTCDATETIME()
    WHERE [id] = ${AFFILIATE_ACCOUNT_ID}`;
  return writeEntry(tx, 'CREDIT', input);
}

/** A debit adjustment: only from what is available, never from held funds. */
export async function debitAvailable(tx: Tx, input: EntryInput): Promise<boolean> {
  const value = roundMoney(input.amount);
  const updated = await tx.$executeRaw`
    UPDATE [dbo].[AffiliateAccount] SET [balance] = [balance] - ${value}, [updatedAt] = SYSUTCDATETIME()
    WHERE [id] = ${AFFILIATE_ACCOUNT_ID} AND [balance] - [reserved] >= ${value - EPSILON}`;
  if (updated !== 1) return false;
  await writeEntry(tx, 'DEBIT', input);
  return true;
}

// ---------------------------------------------------------------------------
// Immediate, risk-reducing action
// ---------------------------------------------------------------------------

export async function freezeAccount(reason: string, actorId: string) {
  await getAffiliateAccount();
  const res = await prisma.affiliateAccount.updateMany({
    where: { id: AFFILIATE_ACCOUNT_ID, status: 'ACTIVE' },
    data: { status: 'FROZEN', frozenReason: reason },
  });
  if (res.count === 0) throw new AffiliateError('The account is already frozen.', 409);
  await createAuditLog({ actorId, action: 'AFFILIATE_ACCOUNT_FROZEN', entity: 'AffiliateAccount', entityId: AFFILIATE_ACCOUNT_ID, details: { reason } });
}

// ---------------------------------------------------------------------------
// Applying approved changes (called from the Approvals flow)
// ---------------------------------------------------------------------------

type ApprovedChange = { id: string; payload: string; createdById: string };

/** Settings (name, account number, CBS provider id) or unfreezing. */
export async function applyAccountChange(change: ApprovedChange, actorId?: string) {
  const updated = JSON.parse(change.payload)?.updated ?? {};
  const data: Record<string, unknown> = {};
  if (typeof updated.name === 'string' && updated.name.trim()) data.name = updated.name.trim();
  if (updated.accountNumber !== undefined) data.accountNumber = updated.accountNumber || null;
  if (updated.cbsProviderId !== undefined) data.cbsProviderId = updated.cbsProviderId || null;
  if (updated.status === 'ACTIVE') {
    data.status = 'ACTIVE';
    data.frozenReason = null;
  }
  if (!Object.keys(data).length) throw new AffiliateError('This request changes nothing.');
  await getAffiliateAccount();
  await prisma.affiliateAccount.update({ where: { id: AFFILIATE_ACCOUNT_ID }, data });
  await createAuditLog({
    actorId: actorId ?? 'system',
    action: updated.status === 'ACTIVE' ? 'AFFILIATE_ACCOUNT_UNFROZEN' : 'AFFILIATE_ACCOUNT_UPDATED',
    entity: 'AffiliateAccount',
    entityId: AFFILIATE_ACCOUNT_ID,
    details: { changeId: change.id, fields: Object.keys(data) },
  });
}

/** Funding (money paid into the account) or an adjustment to match the bank. */
export async function applyAccountMovement(change: ApprovedChange, actorId?: string) {
  const created = JSON.parse(change.payload)?.created ?? {};
  const amount = roundMoney(Number(created.amount));
  const kind = created.kind === 'ADJUSTMENT' ? 'ADJUSTMENT' : 'FUNDING';
  const direction = kind === 'FUNDING' || created.direction === 'CREDIT' ? 'CREDIT' : 'DEBIT';
  const bankReference = typeof created.bankReference === 'string' ? created.bankReference.trim() : '';
  if (!(amount > 0) || !bankReference) throw new AffiliateError('This account movement is not valid.');

  const idempotencyKey = `${kind}:${change.id}`;
  const already = new AffiliateError('This movement was already recorded.', 409);
  if (await prisma.affiliateAccountEntry.findUnique({ where: { idempotencyKey }, select: { id: true } })) throw already;
  if (kind === 'FUNDING') {
    const duplicate = await prisma.affiliateAccountEntry.findFirst({ where: { type: 'FUNDING', bankReference }, select: { reference: true } });
    if (duplicate) throw new AffiliateError(`Funding with bank reference ${bankReference} is already recorded (${duplicate.reference}).`, 409);
  }

  const entry = {
    idempotencyKey,
    type: kind,
    amount,
    bankReference,
    description:
      kind === 'FUNDING'
        ? `Funding of the affiliate account (FT: ${bankReference})${created.note ? ` – ${created.note}` : ''}`
        : `Adjustment (${direction === 'CREDIT' ? 'in' : 'out'}) to match the bank (Ref: ${bankReference}) – ${created.note ?? ''}`,
    createdById: change.createdById,
    approvedById: actorId ?? null,
  } as const;

  try {
    await prisma.$transaction(async (tx) => {
      if (direction === 'CREDIT') {
        await creditAccount(tx, entry);
        return;
      }
      if (!(await debitAvailable(tx, entry))) {
        throw new AffiliateError(`The account's available balance is lower than ${formatMoney(amount)}.`, 409);
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw already;
    throw error;
  }
  await createAuditLog({
    actorId: actorId ?? 'system',
    action: kind === 'FUNDING' ? 'AFFILIATE_ACCOUNT_FUNDED' : 'AFFILIATE_ACCOUNT_ADJUSTED',
    entity: 'AffiliateAccount',
    entityId: AFFILIATE_ACCOUNT_ID,
    details: { changeId: change.id, amount, direction, bankReference },
  });
}
