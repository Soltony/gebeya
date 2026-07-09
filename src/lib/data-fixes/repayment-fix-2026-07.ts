import type { PrismaClient, Prisma } from '@prisma/client';
import { INSTALLMENT_STATUS, isSettledStatus } from '@/lib/installment-status';

/**
 * TypeScript port of scripts/fix-repayment-inconsistencies.sql (and its two
 * follow-ups) for environments where nobody has direct SQL access to the
 * production database: the app server reaches the DB through Prisma, so the
 * fix runs through the app instead (admin API route or CLI script).
 *
 * Every action runs inside one transaction. With { commit: false } (the
 * default) the transaction is rolled back at the end and only the report is
 * returned — identical behaviour to the SQL script's ROLLBACK dry run.
 * All actions are idempotent and safe to re-run.
 */

type Tx = Prisma.TransactionClient;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Sentinel used to force a rollback after a dry run. */
class DryRunRollback extends Error {
  report: FixReport;
  constructor(report: FixReport) { super('dry-run rollback'); this.report = report; }
}

export interface FixReport {
  committed: boolean;
  dustInstallmentsClosed: number;
  mergedWithPaymentsRestored: number;
  doubleCountedSuccessorsDeflated: number;
  settledButActiveDeactivated: number;
  nextInstallmentsActivated: number;
  settledLoansMarkedPaid: number;
  stalePendingIntentsExpired: number;
  ledgerReclassApplied: Array<{ loanId: string; amount: number; skipped?: string }>;
  /** Remaining money/status disagreements after the fix (business items). */
  remainingDisagreements: Array<{ loanId: string; status: string; repaid: number; expected: number; diff: number }>;
  refundsDue: Array<{ loanId: string; borrowerId: string; refundDue: number }>;
  shortfallsOnPaidLoans: Array<{ loanId: string; borrowerId: string; shortfall: number }>;
}

// Loans whose repeat payments were misbooked as service-fee income instead of
// principal (verified against the ledger in the 2026-07-07 audit).
const LEDGER_RECLASS: Array<{ loanId: string; amount: number }> = [
  { loanId: 'cmnu2xyo7029rjg6314cy4ovx', amount: 7288.14 },
  { loanId: 'cmnu46r0802rjjg632qjrg18h', amount: 5045.64 },
];

// Loans marked 'Paid' while the fee share of their merged installments was
// never billed. Reopened via the reopen action so the app can collect.
const UNDER_COLLECTED: Array<{ loanId: string; amount: number }> = [
  { loanId: 'cmnu7pzsz0553jg63irz6qkp3', amount: 485.86 },
  { loanId: 'cmnu88szm05dmjg635fu723zg', amount: 934.37 },
];

const PENDING_INTENT_MAX_AGE_DAYS = 3;

export async function runRepaymentDataFix(
  prisma: PrismaClient,
  opts: { commit: boolean },
): Promise<FixReport> {
  const report: FixReport = {
    committed: opts.commit,
    dustInstallmentsClosed: 0,
    mergedWithPaymentsRestored: 0,
    doubleCountedSuccessorsDeflated: 0,
    settledButActiveDeactivated: 0,
    nextInstallmentsActivated: 0,
    settledLoansMarkedPaid: 0,
    stalePendingIntentsExpired: 0,
    ledgerReclassApplied: [],
    remainingDisagreements: [],
    refundsDue: [],
    shortfallsOnPaidLoans: [],
  };

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();

      // ── A. Close dust-open installments (≤ 1 cent unpaid) ────────────────
      const openInsts = await tx.loanInstallment.findMany({
        where: { status: { notIn: ['Paid', 'Merged'] }, amount: { gt: 0 } },
      });
      for (const i of openInsts) {
        const remaining = i.amount - (i.paidAmount || 0);
        if (remaining >= 0 && remaining <= 0.01) {
          await tx.loanInstallment.update({
            where: { id: i.id },
            data: {
              paidAmount: i.amount,
              status: INSTALLMENT_STATUS.Paid,
              isActive: false,
              paidAt: i.paidAt ?? now,
            },
          });
          report.dustInstallmentsClosed++;
        }
      }

      // ── B. Restore paid installments re-labeled 'Merged' by the old
      //       rollover (amount := paidAmount keeps Σ amounts = principal) ──
      const mergedWithPayments = await tx.loanInstallment.findMany({
        where: { status: 'Merged', paidAmount: { gt: 0.01 }, penaltyAmount: 0 },
      });
      for (const i of mergedWithPayments) {
        await tx.loanInstallment.update({
          where: { id: i.id },
          data: { amount: r2(i.paidAmount || 0), status: INSTALLMENT_STATUS.Paid, isActive: false },
        });
        report.mergedWithPaymentsRestored++;
      }

      // ── B2. Deflate successors double-billed by full-amount/duplicate
      //        merges: excess = Σ amounts − principal, removed from the
      //        first open installment ──────────────────────────────────────
      let loans = await tx.loan.findMany({
        include: { installments: { orderBy: { installmentNumber: 'asc' } } },
      });
      for (const loan of loans) {
        if (loan.installments.length === 0) continue;
        const excess = r2(loan.installments.reduce((a, i) => a + i.amount, 0) - loan.loanAmount);
        if (excess <= 0.01) continue;
        const firstOpen = loan.installments.find(
          (i) => !isSettledStatus(i.status) && i.amount > 0,
        );
        if (firstOpen && firstOpen.amount - excess >= (firstOpen.paidAmount || 0)) {
          await tx.loanInstallment.update({
            where: { id: firstOpen.id },
            data: { amount: r2(firstOpen.amount - excess) },
          });
          report.doubleCountedSuccessorsDeflated++;
        }
      }

      // ── C. Normalize active flags ────────────────────────────────────────
      loans = await tx.loan.findMany({
        include: { installments: { orderBy: { installmentNumber: 'asc' } } },
      });
      for (const loan of loans) {
        for (const i of loan.installments) {
          if (i.isActive && (isSettledStatus(i.status) || i.amount <= 0)) {
            await tx.loanInstallment.update({ where: { id: i.id }, data: { isActive: false } });
            i.isActive = false;
            report.settledButActiveDeactivated++;
          }
        }
        if (loan.repaymentStatus !== 'Unpaid') continue;
        const hasActive = loan.installments.some((i) => i.isActive);
        if (!hasActive) {
          const firstOpen = loan.installments.find(
            (i) => !isSettledStatus(i.status) && i.amount > 0,
          );
          if (firstOpen) {
            await tx.loanInstallment.update({ where: { id: firstOpen.id }, data: { isActive: true } });
            report.nextInstallmentsActivated++;
          }
        }
      }

      // ── D1. Fully settled loans still marked Unpaid → Paid ──────────────
      for (const loan of loans) {
        if (
          loan.repaymentStatus === 'Unpaid' &&
          (loan.repaidAmount || 0) >= loan.loanAmount + loan.serviceFee - 0.01
        ) {
          await tx.loan.update({ where: { id: loan.id }, data: { repaymentStatus: 'Paid' } });
          report.settledLoansMarkedPaid++;
        }
      }

      // ── E. Expire stale PENDING payment intents ──────────────────────────
      const cutoff = new Date(now.getTime() - PENDING_INTENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
      const expired = await tx.pendingPayment.updateMany({
        where: { status: 'PENDING', createdAt: { lt: cutoff } },
        data: { status: 'EXPIRED' },
      });
      report.stalePendingIntentsExpired = expired.count;

      // ── F. Ledger reclassification (fee → principal) ─────────────────────
      for (const { loanId, amount } of LEDGER_RECLASS) {
        const jid = `fixjrn_${loanId}`;
        const already = await tx.journalEntry.findUnique({ where: { id: jid } });
        if (already) {
          report.ledgerReclassApplied.push({ loanId, amount, skipped: 'already applied' });
          continue;
        }
        const loan = await tx.loan.findUnique({ where: { id: loanId }, include: { product: true } });
        if (!loan) {
          report.ledgerReclassApplied.push({ loanId, amount, skipped: 'loan not found' });
          continue;
        }
        // sanity check against the ledger, mirroring the SQL script
        const rows: Array<{ feeCollected: number | null }> = await tx.$queryRaw`
          SELECT SUM(CASE WHEN la.category='ServiceFee' AND la.type='Received' AND le.type='Debit' THEN le.amount ELSE 0 END) AS feeCollected
          FROM LedgerEntry le
          JOIN JournalEntry je ON je.id = le.journalEntryId
          JOIN LedgerAccount la ON la.id = le.ledgerAccountId
          WHERE je.loanId = ${loanId}`;
        const feeOver = (rows[0]?.feeCollected || 0) - loan.serviceFee;
        if (Math.abs(feeOver - amount) > 1.0 && Math.abs(feeOver - 504.52 - amount) > 0.05) {
          throw new Error(`Ledger sanity check failed for ${loanId}: feeOver=${feeOver}, expected reclass=${amount}`);
        }

        const providerId = loan.product.providerId;
        const accounts = await tx.ledgerAccount.findMany({ where: { providerId } });
        const acc = (category: string, type: string) => {
          const a = accounts.find((x) => x.category === category && x.type === type);
          if (!a) throw new Error(`Ledger account ${category}/${type} missing for provider ${providerId}`);
          return a;
        };
        const feeRecv = acc('ServiceFee', 'Receivable');
        const feeRcd = acc('ServiceFee', 'Received');
        const feeInc = acc('ServiceFee', 'Income');
        const prRecv = acc('Principal', 'Receivable');
        const prRcd = acc('Principal', 'Received');

        await tx.journalEntry.create({
          data: {
            id: jid,
            providerId,
            loanId,
            date: now,
            description: `Correction: reclassify ${amount} misbooked as service fee to principal (repeat-payment fee bug)`,
          },
        });
        await tx.ledgerEntry.createMany({
          data: [
            { id: `fixent_${loanId}_1`, journalEntryId: jid, ledgerAccountId: feeRecv.id, type: 'Debit', amount },
            { id: `fixent_${loanId}_2`, journalEntryId: jid, ledgerAccountId: feeRcd.id, type: 'Credit', amount },
            { id: `fixent_${loanId}_3`, journalEntryId: jid, ledgerAccountId: feeInc.id, type: 'Debit', amount },
            { id: `fixent_${loanId}_4`, journalEntryId: jid, ledgerAccountId: prRecv.id, type: 'Credit', amount },
            { id: `fixent_${loanId}_5`, journalEntryId: jid, ledgerAccountId: prRcd.id, type: 'Debit', amount },
          ],
        });
        await tx.ledgerAccount.update({ where: { id: feeRecv.id }, data: { balance: { increment: amount } } });
        await tx.ledgerAccount.update({ where: { id: feeRcd.id }, data: { balance: { decrement: amount } } });
        await tx.ledgerAccount.update({ where: { id: feeInc.id }, data: { balance: { decrement: amount } } });
        await tx.ledgerAccount.update({ where: { id: prRecv.id }, data: { balance: { decrement: amount } } });
        await tx.ledgerAccount.update({ where: { id: prRcd.id }, data: { balance: { increment: amount } } });
        report.ledgerReclassApplied.push({ loanId, amount });
      }

      // ── G. After-state report ────────────────────────────────────────────
      await buildAfterStateReport(tx, report);

      if (!opts.commit) throw new DryRunRollback(report);
    }, { timeout: 180_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.report;
    throw e;
  }
  return report;
}

async function buildAfterStateReport(tx: Tx, report: FixReport): Promise<void> {
  const loans = await tx.loan.findMany();
  for (const l of loans) {
    const expected = r2(l.loanAmount + l.serviceFee);
    const repaid = r2(l.repaidAmount || 0);
    const diff = r2(repaid - expected);
    const disagrees =
      (l.repaymentStatus === 'Paid' && diff < -0.05) ||
      (l.repaymentStatus === 'Unpaid' && diff >= -0.01 && repaid > 0) ||
      diff > 0.05;
    if (disagrees) {
      report.remainingDisagreements.push({ loanId: l.id, status: l.repaymentStatus, repaid, expected, diff });
    }
    if (diff > 0.05) report.refundsDue.push({ loanId: l.id, borrowerId: l.borrowerId, refundDue: diff });
    if (l.repaymentStatus === 'Paid' && diff < -0.05) {
      report.shortfallsOnPaidLoans.push({ loanId: l.id, borrowerId: l.borrowerId, shortfall: -diff });
    }
  }
}

/**
 * Reopen the two under-collected loans so the app can collect the missing
 * fee shares (485.86 / 934.37). Requires the 2026-07-07 code fix to be
 * deployed (which it is, if this module is running).
 */
export async function reopenUnderCollectedLoans(
  prisma: PrismaClient,
  opts: { commit: boolean },
): Promise<Array<{ loanId: string; action: string; outstanding?: number }>> {
  const results: Array<{ loanId: string; action: string; outstanding?: number }> = [];
  for (const { loanId, amount } of UNDER_COLLECTED) {
    const loan = await prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) { results.push({ loanId, action: 'not found' }); continue; }
    const expected = r2(loan.loanAmount + loan.serviceFee);
    const outstanding = r2(expected - (loan.repaidAmount || 0));
    if (loan.repaymentStatus !== 'Paid' || outstanding < 0.05) {
      results.push({ loanId, action: 'skipped (already reopened or collected)', outstanding });
      continue;
    }
    if (Math.abs(outstanding - amount) > 0.05) {
      results.push({ loanId, action: `skipped (outstanding ${outstanding} != expected ${amount})`, outstanding });
      continue;
    }
    if (opts.commit) {
      await prisma.loan.update({
        where: { id: loanId },
        data: { repaymentStatus: 'Unpaid', repaymentBehavior: null },
      });
    }
    results.push({ loanId, action: opts.commit ? 'reopened' : 'would reopen (dry run)', outstanding });
  }
  return results;
}

/**
 * After the reopened loans have paid their shortfall (and are 'Paid' again),
 * reclassify the collected amount from Principal to ServiceFee income.
 */
export async function reclassCollectedShortfalls(
  prisma: PrismaClient,
  opts: { commit: boolean },
): Promise<Array<{ loanId: string; action: string }>> {
  const results: Array<{ loanId: string; action: string }> = [];
  await prisma.$transaction(async (tx) => {
    for (const { loanId, amount } of UNDER_COLLECTED) {
      const jid = `reclsjrn_${loanId}`;
      if (await tx.journalEntry.findUnique({ where: { id: jid } })) {
        results.push({ loanId, action: 'skipped (already reclassed)' });
        continue;
      }
      const loan = await tx.loan.findUnique({ where: { id: loanId }, include: { product: true } });
      if (!loan) { results.push({ loanId, action: 'not found' }); continue; }
      const collected =
        loan.repaymentStatus === 'Paid' &&
        (loan.repaidAmount || 0) >= loan.loanAmount + loan.serviceFee - 0.1;
      if (!collected) {
        results.push({ loanId, action: 'skipped (shortfall not collected yet)' });
        continue;
      }

      const providerId = loan.product.providerId;
      const accounts = await tx.ledgerAccount.findMany({ where: { providerId } });
      const acc = (category: string, type: string) => {
        const a = accounts.find((x) => x.category === category && x.type === type);
        if (!a) throw new Error(`Ledger account ${category}/${type} missing for provider ${providerId}`);
        return a;
      };
      const prRecv = acc('Principal', 'Receivable');
      const prRcd = acc('Principal', 'Received');
      const feeRecv = acc('ServiceFee', 'Receivable');
      const feeRcd = acc('ServiceFee', 'Received');
      const feeInc = acc('ServiceFee', 'Income');

      if (opts.commit) {
        await tx.journalEntry.create({
          data: {
            id: jid, providerId, loanId, date: new Date(),
            description: `Correction: reclassify shortfall collection of ${amount} from principal to service fee`,
          },
        });
        await tx.ledgerEntry.createMany({
          data: [
            { id: `reclsent_${loanId}_1`, journalEntryId: jid, ledgerAccountId: prRecv.id, type: 'Debit', amount },
            { id: `reclsent_${loanId}_2`, journalEntryId: jid, ledgerAccountId: prRcd.id, type: 'Credit', amount },
            { id: `reclsent_${loanId}_3`, journalEntryId: jid, ledgerAccountId: feeRecv.id, type: 'Credit', amount },
            { id: `reclsent_${loanId}_4`, journalEntryId: jid, ledgerAccountId: feeRcd.id, type: 'Debit', amount },
            { id: `reclsent_${loanId}_5`, journalEntryId: jid, ledgerAccountId: feeInc.id, type: 'Credit', amount },
          ],
        });
        await tx.ledgerAccount.update({ where: { id: prRecv.id }, data: { balance: { increment: amount } } });
        await tx.ledgerAccount.update({ where: { id: prRcd.id }, data: { balance: { decrement: amount } } });
        await tx.ledgerAccount.update({ where: { id: feeRecv.id }, data: { balance: { decrement: amount } } });
        await tx.ledgerAccount.update({ where: { id: feeRcd.id }, data: { balance: { increment: amount } } });
        await tx.ledgerAccount.update({ where: { id: feeInc.id }, data: { balance: { increment: amount } } });
      }
      results.push({ loanId, action: opts.commit ? 'reclassed' : 'would reclass (dry run)' });
    }
  }, { timeout: 60_000 });
  return results;
}
