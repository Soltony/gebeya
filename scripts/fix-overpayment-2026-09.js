/**
 * OVERPAYMENT FIX - 2026-09 (loan cmnu46r0802rjjg632qjrg18h, "2qjrg18h")
 *
 *   node scripts/fix-overpayment-2026-09.js            # dry run (rolled back)
 *   node scripts/fix-overpayment-2026-09.js --commit   # apply
 *
 * Connects with DATABASE_URL (from the environment or .env).
 *
 * Same approach as Halal-Gebeya's fix-repayment-data-2026-09 (step 4): the
 * overpayment is removed from the books, the bank refunds it to the borrower,
 * and an AuditLog row records the removal.
 *
 * What happened: after installment 3 (06-25) only installment 4's principal
 * (5,045.64) was owed. The borrower then paid 11 x 504.56 = 5,550.16, all
 * booked as service fee (the pre-fix repeat-payment bug). The 2026-07 fix
 * reclassified 5,045.64 of that to principal and left the rest, 504.52, as a
 * refundable overpayment. Unlike Halal's case no single payment equals the
 * overpayment: it is all but 0.04 of the last 504.56 payment.
 *
 * Steps:
 *   1. The 06-09 payment of 504.57 was booked as 504.5675 (fee 504.5625 +
 *      principal 0.005). Book the missing 0.0025 as principal so the journal
 *      equals the payment and principal received equals the loan amount.
 *   2. Reduce the last 504.56 payment (TxRef 056180f1-...) to the 0.04 that
 *      was owed: payment amount, its service-fee ledger lines and
 *      loan.repaidAmount all drop by 504.52. The gateway intent stays
 *      COMPLETED so a replayed callback cannot book it again.
 *   3. Close installment 4, which was left Pending/active on a Paid loan
 *      although its principal is fully received.
 *
 * Safe to re-run: each step checks state first and is skipped once done.
 * Any drift from the audited figures aborts the whole run.
 *
 * Journals are read with explicit `select`s so the script does not depend on
 * JournalEntry columns the database may not have yet.
 */
require('dotenv/config');
const { PrismaClient } = require('@prisma/client');

const LOAN_ID = 'cmnu46r0802rjjg632qjrg18h';
const TAG = '2qjrg18h';

const DUST = {
  journalId: 'cmq86q6za03pz10ncisugm8u6',
  paymentAmount: 504.57,
  prBefore: 0.005,
  feeBefore: 504.5625,
  amount: 0.0025,
};

const OVERPAYMENT = {
  journalId: 'cmqv1fc5r04pb10ncqdu8wdgk',
  txnRef: '056180f1-69b5-44f0-9e8c-8f1dbcb58cf3',
  paymentBefore: 504.56,
  amount: 504.52,
};

const INSTALLMENT_NUMBER = 4;
const AUDIT_ID = `fixaudit202609_refund_${LOAN_ID}`;
const EPS = 0.00005;

class DryRunRollback extends Error {}

const round4 = (v) => Math.round(v * 10000) / 10000;
const fmt = (v, dp = 4) => Number(v).toFixed(dp);

function abort(message) {
  throw new Error(`${message}; aborting.`);
}

// Balance convention used by the app: Income accounts grow on Credit, all
// others on Debit.
function balanceSign(accountType, entryType) {
  return (accountType === 'Income') === (entryType === 'Credit') ? 1 : -1;
}

function isSettledStatus(status) {
  const s = (status || '').toLowerCase();
  return s === 'paid' || s === 'merged';
}

/** Net Received amounts (debit - credit) for principal and service fee. */
async function receivedSplit(tx, where) {
  const entries = await tx.ledgerEntry.findMany({
    where: { ...where, ledgerAccount: { type: 'Received' } },
    select: { type: true, amount: true, ledgerAccount: { select: { category: true } } },
  });
  let principal = 0;
  let fee = 0;
  for (const e of entries) {
    const signed = e.type === 'Debit' ? e.amount : -e.amount;
    if (e.ledgerAccount.category === 'Principal') principal += signed;
    else if (e.ledgerAccount.category === 'ServiceFee') fee += signed;
  }
  return { principal, fee };
}

/**
 * Changes one ledger line of a journal by `delta` (inserting the line if
 * needed) and moves the account balance with it.
 */
async function adjustEntry(tx, journalId, account, entryType, delta) {
  const lines = await tx.ledgerEntry.findMany({
    where: { journalEntryId: journalId, ledgerAccountId: account.id, type: entryType },
  });
  if (lines.length > 1) abort(`journal ${journalId} has several ${entryType} lines on one account`);

  if (lines.length === 0) {
    if (delta < 0) abort(`nothing to reduce in journal ${journalId}`);
    await tx.ledgerEntry.create({
      data: {
        id: `rst202609_${journalId}_${account.id}_${entryType}`,
        journalEntryId: journalId,
        ledgerAccountId: account.id,
        type: entryType,
        amount: round4(delta),
      },
    });
  } else {
    const newAmount = lines[0].amount + delta;
    if (newAmount < EPS) abort(`line in journal ${journalId} would reach zero or go negative`);
    await tx.ledgerEntry.update({ where: { id: lines[0].id }, data: { amount: round4(newAmount) } });
  }

  await tx.ledgerAccount.update({
    where: { id: account.id },
    data: { balance: { increment: delta * balanceSign(account.type, entryType) } },
  });
}

async function providerAccounts(tx, providerId) {
  const accounts = await tx.ledgerAccount.findMany({ where: { providerId } });
  return (category, type) => {
    const found = accounts.filter((a) => a.category === category && a.type === type);
    if (found.length !== 1) abort(`ledger account ${category}/${type} missing or duplicated for provider`);
    return found[0];
  };
}

/** Per-account (balance - sum of its entries), to show the fix adds no drift. */
async function balanceDrift(tx) {
  const accounts = await tx.ledgerAccount.findMany();
  const sums = await tx.ledgerEntry.groupBy({ by: ['ledgerAccountId', 'type'], _sum: { amount: true } });
  const drift = new Map();
  for (const a of accounts) {
    const fromEntries = sums
      .filter((s) => s.ledgerAccountId === a.id)
      .reduce((acc, s) => acc + (s._sum.amount || 0) * balanceSign(a.type, s.type), 0);
    drift.set(a.id, { name: a.name, drift: a.balance - fromEntries });
  }
  return drift;
}

async function printReport(tx) {
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: LOAN_ID } });
  const entries = await tx.ledgerEntry.findMany({
    where: { journalEntry: { loanId: LOAN_ID } },
    select: { type: true, amount: true, ledgerAccount: { select: { category: true, type: true } } },
  });
  const net = (category, type) =>
    entries
      .filter((e) => e.ledgerAccount.category === category && e.ledgerAccount.type === type)
      .reduce((acc, e) => acc + (e.type === 'Debit' ? e.amount : -e.amount), 0);
  const installments = await tx.loanInstallment.findMany({ where: { loanId: LOAN_ID } });
  const payments = await tx.payment.findMany({ where: { loanId: LOAN_ID } });
  const repaid = loan.repaidAmount || 0;

  console.table([
    {
      tag: TAG,
      status: loan.repaymentStatus,
      owed: round4(loan.loanAmount + loan.serviceFee),
      repaid: round4(repaid),
      repaidVsOwed: round4(repaid - loan.loanAmount - loan.serviceFee),
      paymentsVsRepaid: round4(payments.reduce((a, p) => a + p.amount, 0) - repaid),
      principalRcvdDiff: round4(net('Principal', 'Received') - loan.loanAmount),
      feeRcvdDiff: round4(net('ServiceFee', 'Received') - loan.serviceFee),
      principalOpen: round4(net('Principal', 'Receivable')),
      feeOpen: round4(net('ServiceFee', 'Receivable')),
      instPaidVsPrincipal: round4(installments.reduce((a, i) => a + (i.paidAmount || 0), 0) - loan.loanAmount),
      openInst: installments.filter((i) => !isSettledStatus(i.status) && i.amount > 0).length,
      activeInst: installments.filter((i) => i.isActive).length,
    },
  ]);
}

async function runFix(tx) {
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: LOAN_ID }, include: { product: true } });
  const account = await providerAccounts(tx, loan.product.providerId);
  const driftBefore = await balanceDrift(tx);

  console.log('=== BEFORE ===');
  await printReport(tx);

  // --- 1. Book the 0.0025 principal missing from the 06-09 journal ----------
  {
    const journal = await tx.journalEntry.findFirst({
      where: { id: DUST.journalId, loanId: LOAN_ID },
      select: { id: true },
    });
    if (!journal) abort(`1. journal ${DUST.journalId} not found for loan`);
    const payment = await tx.payment.findFirst({ where: { journalEntryId: DUST.journalId } });
    if (!payment || Math.abs(payment.amount - DUST.paymentAmount) > 0.001) abort('1. 06-09 payment drifted from audit');

    const current = await receivedSplit(tx, { journalEntryId: DUST.journalId });
    if (Math.abs(current.fee - DUST.feeBefore) > EPS) abort(`1. fee split drifted (${fmt(current.fee)})`);

    if (Math.abs(current.principal - (DUST.prBefore + DUST.amount)) <= EPS) {
      console.log('1. 06-09 journal already complete - skipped');
    } else if (Math.abs(current.principal - DUST.prBefore) <= EPS) {
      // A repayment credits the receivable and debits received.
      await adjustEntry(tx, DUST.journalId, account('Principal', 'Receivable'), 'Credit', DUST.amount);
      await adjustEntry(tx, DUST.journalId, account('Principal', 'Received'), 'Debit', DUST.amount);
      console.log(`1. 06-09 journal: booked missing principal ${fmt(DUST.amount)}`);
    } else {
      abort(`1. principal split drifted (${fmt(current.principal)})`);
    }
  }

  // --- 2. Remove the 504.52 overpayment from the books -----------------------
  {
    const { journalId, txnRef, paymentBefore, amount } = OVERPAYMENT;
    const journal = await tx.journalEntry.findFirst({
      where: { id: journalId, loanId: LOAN_ID },
      select: { id: true, description: true },
    });
    if (!journal || !journal.description.includes(txnRef)) abort(`2. journal ${journalId} not found for TxRef`);
    const payment = await tx.payment.findFirst({ where: { journalEntryId: journalId } });
    if (!payment) abort('2. overpaid payment record missing');

    const current = await tx.loan.findUniqueOrThrow({ where: { id: LOAN_ID } });
    const overpaid = (current.repaidAmount || 0) - current.loanAmount - current.serviceFee;
    const kept = round4(paymentBefore - amount);
    const audit = await tx.auditLog.findUnique({ where: { id: AUDIT_ID } });

    if (Math.abs(payment.amount - kept) <= 0.001 && audit) {
      if (Math.abs(overpaid) > 0.01) abort('2. overpayment removed but loan is not settled exactly');
      console.log('2. overpayment already removed - skipped');
    } else {
      const split = await receivedSplit(tx, { journalEntryId: journalId });
      if (
        audit ||
        Math.abs(payment.amount - paymentBefore) > 0.001 ||
        Math.abs(split.fee - paymentBefore) > 0.001 ||
        Math.abs(split.principal) > EPS
      ) {
        abort('2. overpaid payment drifted from audit');
      }
      if (Math.abs(overpaid - amount) > 0.01) abort(`2. loan is overpaid by ${fmt(overpaid, 2)}, not the audited ${amount}`);

      // A fee repayment credits the receivable, debits received and credits income.
      await adjustEntry(tx, journalId, account('ServiceFee', 'Receivable'), 'Credit', -amount);
      await adjustEntry(tx, journalId, account('ServiceFee', 'Received'), 'Debit', -amount);
      await adjustEntry(tx, journalId, account('ServiceFee', 'Income'), 'Credit', -amount);
      await tx.payment.update({ where: { id: payment.id }, data: { amount: kept } });
      await tx.loan.update({ where: { id: LOAN_ID }, data: { repaidAmount: { decrement: amount } } });

      await tx.auditLog.create({
        data: {
          id: AUDIT_ID,
          actorId: 'data-fix-2026-09',
          action: 'OVERPAYMENT_REMOVED_FOR_REFUND',
          entity: 'LOAN',
          entityId: LOAN_ID,
          details: JSON.stringify({
            txnRef,
            amount,
            paymentId: payment.id,
            journalEntryId: journalId,
            paymentAmountBefore: paymentBefore,
            paymentAmountAfter: kept,
            paymentDate: payment.date.toISOString(),
            note: 'Overpayment removed from the books; to be refunded to the borrower by the bank.',
          }),
          createdAt: new Date(),
        },
      });

      console.log(`2. overpayment removed: ${fmt(amount, 2)} (payment ${fmt(paymentBefore, 2)} -> ${fmt(kept, 2)})`);
    }
  }

  // --- 3. Close installment 4 -------------------------------------------------
  {
    const inst = await tx.loanInstallment.findFirst({
      where: { loanId: LOAN_ID, installmentNumber: INSTALLMENT_NUMBER },
    });
    if (!inst) abort(`3. installment ${INSTALLMENT_NUMBER} not found`);

    if (isSettledStatus(inst.status) && !inst.isActive) {
      console.log(`3. installment ${INSTALLMENT_NUMBER} already closed - skipped`);
    } else {
      const others = await tx.loanInstallment.findMany({
        where: { loanId: LOAN_ID, installmentNumber: { not: INSTALLMENT_NUMBER } },
      });
      const paidElsewhere = others.reduce((a, i) => a + (i.paidAmount || 0), 0);
      if (Math.abs(paidElsewhere + inst.amount - loan.loanAmount) > 0.01) {
        abort(`3. installments would not add up to the principal (${fmt(paidElsewhere + inst.amount)})`);
      }
      // Paid by the 06-25 payments (the last one is the overpaid one).
      const lastPayment = await tx.payment.findFirst({ where: { journalEntryId: OVERPAYMENT.journalId } });
      await tx.loanInstallment.update({
        where: { id: inst.id },
        data: { paidAmount: inst.amount, status: 'Paid', isActive: false, paidAt: inst.paidAt || lastPayment.date },
      });
      console.log(`3. installment ${INSTALLMENT_NUMBER} closed (${fmt(inst.amount, 2)})`);
    }
  }

  // --- 4. Final checks and after-state ----------------------------------------
  {
    const after = await tx.loan.findUniqueOrThrow({ where: { id: LOAN_ID } });
    const repaid = after.repaidAmount || 0;
    const payments = await tx.payment.findMany({ where: { loanId: LOAN_ID } });
    const split = await receivedSplit(tx, { journalEntry: { loanId: LOAN_ID } });
    if (Math.abs(payments.reduce((a, p) => a + p.amount, 0) - repaid) > 0.001) abort('4. payments do not add up to repaidAmount');
    if (Math.abs(repaid - after.loanAmount - after.serviceFee) > 0.001) abort(`4. repaid ${fmt(repaid)} is not what is owed`);
    if (Math.abs(split.principal - after.loanAmount) > EPS || Math.abs(split.fee - after.serviceFee) > EPS) {
      abort(`4. ledger does not match what is owed (principal ${fmt(split.principal)}, fee ${fmt(split.fee)})`);
    }
  }

  console.log('=== AFTER ===');
  await printReport(tx);

  console.log('=== Ledger balance drift changed by this fix (expect none) ===');
  const driftAfter = await balanceDrift(tx);
  const changed = [];
  for (const [id, { name, drift }] of driftAfter) {
    const before = driftBefore.get(id)?.drift ?? 0;
    if (Math.abs(drift - before) > 0.00001) changed.push({ name, before: round4(before), after: round4(drift) });
  }
  if (changed.length > 0) {
    console.table(changed);
    abort('4. account balances moved out of step with their entries');
  }
  console.log('(none)');
}

async function main() {
  const commit = process.argv.includes('--commit');
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(
      async (tx) => {
        await runFix(tx);
        if (!commit) throw new DryRunRollback();
      },
      { maxWait: 10_000, timeout: 120_000 }
    );
    console.log('*** COMMITTED ***');
  } catch (e) {
    if (e instanceof DryRunRollback) {
      console.log('*** DRY RUN - rolled back. Re-run with --commit to apply. ***');
    } else {
      console.error(`*** FAILED - nothing was changed: ${e.message} ***`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}

module.exports = { runFix };
