/**
 * Maker steps and admin views for the Affiliate Program account. Every change
 * that adds money or spending power goes to the Approvals page; a checker
 * approves it there (applied by account.ts).
 */
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { formatMoney } from './config';
import { roundMoney } from './engine';
import { AFFILIATE_ACCOUNT_ID, getAccountState } from './account';
import { AffiliateError } from './programs';
import { createAffiliateChangeRequest, pendingRequests } from './requests';
import { TRANSFER_PURPOSES, TRANSFER_STATUSES } from './transfers';

const ACCOUNT_FIELD = /^[A-Za-z0-9]{1,34}$/;
const MAX_MOVEMENT = 1_000_000_000;

export async function requestAccountSettingsChange(
  user: { id: string },
  input: { name: string; accountNumber: string | null; cbsProviderId: string | null }
) {
  const account = await getAccountState();
  const name = input.name.trim();
  if (name.length < 2) throw new AffiliateError('Give the account a name.');
  const accountNumber = input.accountNumber?.trim() || null;
  const cbsProviderId = input.cbsProviderId?.trim() || null;
  if (accountNumber && !ACCOUNT_FIELD.test(accountNumber)) throw new AffiliateError('The account number can only contain letters and digits.');
  if (cbsProviderId && !/^[A-Za-z0-9_-]{1,40}$/.test(cbsProviderId)) throw new AffiliateError('The CBS provider id can only contain letters, digits, - and _.');
  if (name === account.name && accountNumber === account.accountNumber && cbsProviderId === account.cbsProviderId) {
    throw new AffiliateError('Nothing was changed.');
  }
  return createAffiliateChangeRequest(user, {
    entityType: 'AffiliateAccount',
    entityId: AFFILIATE_ACCOUNT_ID,
    changeType: 'UPDATE',
    payload: {
      original: { name: account.name, accountNumber: account.accountNumber, cbsProviderId: account.cbsProviderId },
      updated: { name, accountNumber, cbsProviderId },
    },
  });
}

export async function requestAccountUnfreeze(user: { id: string }) {
  const account = await getAccountState();
  if (account.status !== 'FROZEN') throw new AffiliateError('The account is not frozen.', 409);
  return createAffiliateChangeRequest(user, {
    entityType: 'AffiliateAccount',
    entityId: AFFILIATE_ACCOUNT_ID,
    changeType: 'UPDATE',
    payload: {
      original: { name: account.name, status: 'FROZEN', frozenReason: account.frozenReason },
      updated: { name: account.name, status: 'ACTIVE' },
    },
  });
}

/**
 * Funding: money the bank paid into the account (one bank reference, once).
 * Adjustment: brings the ledger in line with the bank statement (in or out).
 */
export async function requestAccountMovement(
  user: { id: string },
  input: { kind: 'FUNDING' | 'ADJUSTMENT'; direction: 'CREDIT' | 'DEBIT'; amount: number; bankReference: string; note: string | null }
) {
  const amount = roundMoney(Number(input.amount));
  if (!(amount > 0) || amount > MAX_MOVEMENT) throw new AffiliateError('Enter an amount above 0.');
  const bankReference = input.bankReference.trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(bankReference)) throw new AffiliateError('Enter the bank reference (FT number) of this movement.');
  const direction = input.kind === 'FUNDING' ? 'CREDIT' : input.direction;
  const note = input.note?.trim() || null;
  if (input.kind === 'ADJUSTMENT' && !note) throw new AffiliateError('Say why the adjustment is needed.');

  if (input.kind === 'FUNDING') {
    const used = await prisma.affiliateAccountEntry.findFirst({ where: { type: 'FUNDING', bankReference }, select: { reference: true } });
    if (used) throw new AffiliateError(`This bank reference is already recorded (${used.reference}).`, 409);
    const waiting = await prisma.pendingChange.findMany({
      where: { entityType: 'AffiliateAccountMovement', status: 'PENDING' },
      select: { payload: true },
    });
    if (waiting.some((w) => JSON.parse(w.payload)?.created?.bankReference === bankReference)) {
      throw new AffiliateError('A funding request with this bank reference is already waiting for approval.', 409);
    }
  }
  if (direction === 'DEBIT') {
    const account = await getAccountState();
    if (account.available < amount) throw new AffiliateError(`Only ${formatMoney(account.available)} is available.`, 409);
  }

  const verb = input.kind === 'FUNDING' ? 'Fund' : direction === 'CREDIT' ? 'Adjust in' : 'Adjust out';
  return createAffiliateChangeRequest(user, {
    entityType: 'AffiliateAccountMovement',
    changeType: 'CREATE',
    payload: {
      created: { name: `${verb} ${formatMoney(amount)} (FT: ${bankReference})`, kind: input.kind, direction, amount, bankReference, note },
    },
  });
}

export async function accountOverview() {
  const [account, pending, waitingForReview, failed, unapplied] = await Promise.all([
    getAccountState(),
    Promise.all([pendingRequests('AffiliateAccount'), pendingRequests('AffiliateAccountMovement')]),
    prisma.affiliateTransfer.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.affiliateTransfer.count({ where: { status: 'FAILED' } }),
    prisma.affiliateTransfer.count({ where: { status: 'SENT_UNAPPLIED' } }),
  ]);
  return {
    account,
    settingsPending: pending[0].length > 0,
    pendingMovements: pending[1].map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
    attention: { waitingForReview, failed, unapplied },
  };
}

export async function listAccountEntries(input: { type?: string | null; search?: string | null; take?: number }) {
  const where: Prisma.AffiliateAccountEntryWhereInput = {};
  if (input.type) where.type = input.type;
  const search = input.search?.trim();
  if (search) {
    where.OR = [
      { reference: { contains: search.toUpperCase() } },
      { bankReference: { contains: search } },
      { counterpartyAccount: { contains: search } },
    ];
  }
  return prisma.affiliateAccountEntry.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(input.take ?? 200, 500) });
}

export async function listTransfers(input: { purpose?: string | null; status?: string | null; search?: string | null; take?: number }) {
  const where: Prisma.AffiliateTransferWhereInput = {};
  if (input.purpose && (TRANSFER_PURPOSES as readonly string[]).includes(input.purpose)) where.purpose = input.purpose;
  if (input.status && (TRANSFER_STATUSES as readonly string[]).includes(input.status)) where.status = input.status;
  const search = input.search?.trim();
  if (search) {
    where.OR = [
      { reference: { contains: search.toUpperCase() } },
      { phone: { contains: search.replace(/\D/g, '') || search } },
      { transactionId: { contains: search } },
      { orderId: search },
      { loanId: search },
    ];
  }
  return prisma.affiliateTransfer.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(input.take ?? 200, 500) });
}
