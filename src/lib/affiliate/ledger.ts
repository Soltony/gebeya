/**
 * Provider-ledger postings for PROVIDER-funded affiliate commissions.
 * PLATFORM-funded commissions have no ledger here (the platform has no ledger
 * of its own in this system); the commission and payout tables are their record.
 *
 * Journals are posted without a loanId on purpose: loan-level reports read
 * every journal linked to a loan, and commissions are not loan transactions.
 * The loan/order reference goes in the description instead.
 */
import type { Prisma } from '@prisma/client';
import { roundMoney } from './engine';

type Tx = Prisma.TransactionClient;

export const COMMISSION_EXPENSE_ACCOUNT = { name: 'Commission Expense', type: 'Expense', category: 'Commission' } as const;
export const COMMISSION_PAYABLE_ACCOUNT = { name: 'Commission Payable', type: 'Payable', category: 'Commission' } as const;

type AccountDefinition = { name: string; type: string; category: string };

// Providers created before this feature don't have these accounts yet.
async function ensureAccount(tx: Tx, providerId: string, def: AccountDefinition) {
  return tx.ledgerAccount.upsert({
    where: { providerId_name: { providerId, name: def.name } },
    update: {},
    create: { providerId, name: def.name, type: def.type, category: def.category, balance: 0 },
  });
}

/**
 * A commission becomes payable: Dr Commission Expense, Cr Commission Payable.
 * A negative amount (a commission taken back) posts the reverse.
 */
export async function postCommissionAccrual(
  tx: Tx,
  input: { providerId: string; amount: number; date: Date; description: string }
) {
  const amount = roundMoney(input.amount);
  if (amount === 0) return;
  const expense = await ensureAccount(tx, input.providerId, COMMISSION_EXPENSE_ACCOUNT);
  const payable = await ensureAccount(tx, input.providerId, COMMISSION_PAYABLE_ACCOUNT);
  const journal = await tx.journalEntry.create({
    data: { providerId: input.providerId, date: input.date, description: input.description },
  });
  const value = Math.abs(amount);
  await tx.ledgerEntry.createMany({
    data: [
      { journalEntryId: journal.id, ledgerAccountId: expense.id, type: amount > 0 ? 'Debit' : 'Credit', amount: value },
      { journalEntryId: journal.id, ledgerAccountId: payable.id, type: amount > 0 ? 'Credit' : 'Debit', amount: value },
    ],
  });
  await tx.ledgerAccount.update({ where: { id: expense.id }, data: { balance: { increment: amount } } });
  await tx.ledgerAccount.update({ where: { id: payable.id }, data: { balance: { increment: amount } } });
}

/**
 * A payout succeeded: Dr Commission Payable. Cash is not modelled in this
 * ledger, the same as for loan disbursements.
 */
export async function postCommissionPayment(
  tx: Tx,
  input: { providerId: string; amount: number; date: Date; description: string }
) {
  const amount = roundMoney(input.amount);
  if (amount === 0) return;
  const payable = await ensureAccount(tx, input.providerId, COMMISSION_PAYABLE_ACCOUNT);
  const journal = await tx.journalEntry.create({
    data: { providerId: input.providerId, date: input.date, description: input.description },
  });
  await tx.ledgerEntry.create({
    data: { journalEntryId: journal.id, ledgerAccountId: payable.id, type: amount > 0 ? 'Debit' : 'Credit', amount: Math.abs(amount) },
  });
  await tx.ledgerAccount.update({ where: { id: payable.id }, data: { balance: { decrement: amount } } });
}
