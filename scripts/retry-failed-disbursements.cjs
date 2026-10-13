/**
 * Retries BNPL disbursements that FAILED at the core banking system.
 *
 * ⚠ THIS MOVES REAL MONEY. Each retry calls the app's own disbursement
 * endpoint, which calls CBS and records the real transaction reference.
 * Nothing is faked: a loan only becomes "Success" in the reports when CBS
 * actually accepts the transfer.
 *
 * Run from the app folder (the one with node_modules and .env), on the
 * machine that runs the app:
 *   node scripts/retry-failed-disbursements.cjs                 -> DRY RUN (lists loans, calls nothing)
 *   node scripts/retry-failed-disbursements.cjs --commit --limit 1   -> retry ONE loan first
 *   node scripts/retry-failed-disbursements.cjs --commit         -> retry the rest
 *
 * Options:
 *   --limit N        only the first N loans (do a single one first)
 *   --loans a,b,c    only these loan ids
 *   --since DATE     loans disbursed on/after this date (default 2026-09-01)
 *   --base-url URL   where the app is running (default http://localhost:3001)
 *   --no-sms         do not text the borrower (credits the merchant directly)
 *   --delay MS       pause between calls (default 2000)
 *
 * A loan that already has a successful disbursement is always skipped, so
 * re-running after an interruption cannot pay twice.
 */
const fs = require('fs');
const path = require('path');

const fromApp = (name) => require.resolve(name, { paths: [process.cwd(), __dirname] });
try {
  require(fromApp('dotenv')).config();
} catch {
  // DATABASE_URL may already be set in the environment.
}

let PrismaClient;
try {
  ({ PrismaClient } = require(fromApp('@prisma/client')));
} catch {
  console.error('Could not load @prisma/client. Run this from the app folder (the one with node_modules).');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run from the app folder that has the .env file.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};

const commit = flag('commit');
const noSms = flag('no-sms');
const gross = flag('gross');
const baseUrl = String(value('base-url', 'http://localhost:3001')).replace(/\/$/, '');
const since = new Date(value('since', '2026-09-01'));
const onlyLoans = String(value('loans', '')).split(',').map((s) => s.trim()).filter(Boolean);
const limit = parseInt(value('limit', '0'), 10) || 0;
const delayMs = parseInt(value('delay', '2000'), 10);

if (Number.isNaN(since.getTime())) {
  console.error('--since must be a date like 2026-09-01');
  process.exit(1);
}

const prisma = new PrismaClient();
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SUCCESSFUL = {
  OR: [
    { disbursementStatus: 'SUCCESS' },
    { AND: [{ disbursementStatus: { not: 'FAILED' } }, { statusCode: { gte: 200 } }, { statusCode: { lt: 300 } }] },
  ],
};

async function hasSuccessfulDisbursement(loanId) {
  return (await prisma.disbursementTransaction.count({ where: { loanId, ...SUCCESSFUL } })) > 0;
}

async function buildTargets() {
  const loans = await prisma.loan.findMany({
    where: {
      disbursedDate: { gte: since },
      repaymentStatus: { not: 'REVERSED' },
      disbursementTransactions: { none: SUCCESSFUL },
      ...(onlyLoans.length ? { id: { in: onlyLoans } } : {}),
    },
    include: {
      product: { include: { provider: { select: { id: true, name: true } } } },
      disbursementTransactions: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { disbursedDate: 'asc' },
  });

  const targets = [];
  for (const loan of loans) {
    const last = loan.disbursementTransactions[0] || null;
    let attempted = null;
    let attemptedProviderId = null;
    try {
      const req = last && last.requestPayload ? JSON.parse(last.requestPayload) : null;
      if (req) {
        const a = Number(req.amount);
        if (Number.isFinite(a) && a > 0) attempted = a;
        if (req.providerId) attemptedProviderId = String(req.providerId);
      }
    } catch {
      // fall back to the loan's own amounts
    }

    const order = await prisma.order.findFirst({
      where: { loanId: loan.id },
      include: { merchant: { select: { accountNumber: true, name: true } } },
    });
    const borrowerAccount = await prisma.phoneAccount.findFirst({
      where: { phoneNumber: loan.borrowerId },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      select: { accountNumber: true },
    });

    const merchantAccount = order && order.merchant ? order.merchant.accountNumber : null;
    const attemptedAmount = money(attempted != null ? attempted : loan.netDisbursedAmount != null ? loan.netDisbursedAmount : loan.loanAmount);
    // --gross pays the item price (the loan amount) instead of the amount the
    // first attempt sent, which was net of the 1% inclusive tax withheld then.
    const amount = gross ? money(loan.loanAmount) : attemptedAmount;
    // The endpoint swaps in the merchant account for BNPL orders. Sending the
    // borrower's account makes it text the borrower; sending the merchant's does not.
    const creditAccount = noSms || !borrowerAccount ? merchantAccount : borrowerAccount.accountNumber;

    targets.push({
      loanId: loan.id,
      disbursedOn: loan.disbursedDate.toISOString().slice(0, 10),
      borrowerId: loan.borrowerId,
      loanAmount: loan.loanAmount,
      amount,
      attemptedAmount,
      taxWithheldAtBooking: money(loan.taxDeducted || 0),
      merchant: order && order.merchant ? order.merchant.name : null,
      merchantAccount,
      creditAccount,
      providerId: attemptedProviderId || (loan.product && loan.product.provider ? loan.product.provider.id : null),
      repaymentStatus: loan.repaymentStatus,
      lastStatusCode: last ? last.statusCode : null,
      lastError: last ? String(last.rawResponse || '').replace(/\s+/g, ' ').slice(0, 70) : '(never attempted)',
      blocked: !merchantAccount ? 'no merchant account on the order' : null,
    });
  }
  return limit > 0 ? targets.slice(0, limit) : targets;
}

async function retryOne(t) {
  if (await hasSuccessfulDisbursement(t.loanId)) {
    return { ...t, result: 'SKIPPED - already disbursed', httpStatus: null, cbsReference: null };
  }
  let httpStatus = null;
  let body = null;
  try {
    const res = await fetch(`${baseUrl}/api/external/disbursement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creditAccount: t.creditAccount,
        providerId: t.providerId || 'PRO0002',
        amount: t.amount,
        loanId: t.loanId,
      }),
    });
    httpStatus = res.status;
    body = await res.text().catch(() => null);
  } catch (e) {
    const err = new Error(`Could not reach the app at ${baseUrl} (${String((e && e.message) || e)})`);
    err.unreachable = true;
    throw err;
  }

  // Trust the database, not the HTTP reply: the endpoint records what CBS did.
  const saved = await prisma.disbursementTransaction.findFirst({
    where: { loanId: t.loanId },
    orderBy: { createdAt: 'desc' },
  });
  const ok = saved && (saved.disbursementStatus === 'SUCCESS' || (saved.statusCode >= 200 && saved.statusCode < 300));
  return {
    ...t,
    httpStatus,
    cbsReference: saved ? saved.transactionId : null,
    result: ok ? 'SUCCESS' : 'STILL FAILING',
    detail: ok ? null : String((saved && saved.rawResponse) || body || '').replace(/\s+/g, ' ').slice(0, 160),
  };
}

async function main() {
  const target = (process.env.DATABASE_URL.match(/^sqlserver:\/\/([^;]+);.*?database=([^;]+)/i) || []).slice(1);
  console.log(`Database: ${target.length ? `${target[0]} / ${target[1]}` : '(from DATABASE_URL)'}`);
  console.log(`App URL:  ${baseUrl}`);
  console.log(commit ? '*** COMMIT - THIS MOVES REAL MONEY ***' : '*** DRY RUN - no payment will be attempted ***');
  if (noSms) console.log('--no-sms: the borrower will not be texted');
  if (gross) console.log('--gross: paying the full loan amount, not the reduced amount first attempted');

  const targets = await buildTargets();
  if (targets.length === 0) {
    console.log('\nNo loans are waiting for a disbursement retry.');
    return;
  }

  console.log(`\n${targets.length} loan(s) with no successful disbursement since ${since.toISOString().slice(0, 10)}`);
  console.table(targets.map((t) => ({
    loanId: t.loanId,
    disbursedOn: t.disbursedOn,
    amount: t.amount,
    merchantAccount: t.merchantAccount,
    firstAttempted: t.attemptedAmount,
    taxWithheld: t.taxWithheldAtBooking,
    status: t.repaymentStatus,
    lastError: t.blocked || t.lastError,
  })));
  const total = money(targets.reduce((a, t) => a + (t.blocked ? 0 : t.amount), 0));
  console.log(`Total to be paid to the merchant: ${total}`);
  const needTaxFix = targets.filter((t) => !t.blocked && t.taxWithheldAtBooking > 0 && t.amount > t.attemptedAmount);
  if (needTaxFix.length > 0) {
    console.log(`NOTE: ${needTaxFix.length} loan(s) are being paid ${money(needTaxFix.reduce((a2, t) => a2 + (t.amount - t.attemptedAmount), 0))} more than first attempted.`);
    console.log('      Afterwards run the tax-record correction (fix-inclusive-tax-on-gross-paid-loans.sql).');
  }

  const payable = targets.filter((t) => !t.blocked);
  if (targets.length !== payable.length) {
    console.log(`${targets.length - payable.length} loan(s) cannot be paid: no merchant account on the order.`);
  }

  if (!commit) {
    console.log('\nDRY RUN - nothing was sent. Re-run with --commit --limit 1 to pay the first one.');
    return;
  }

  const results = [];
  for (let i = 0; i < payable.length; i++) {
    const t = payable[i];
    process.stdout.write(`\n[${i + 1}/${payable.length}] ${t.loanId} ${t.amount} -> ${t.merchantAccount} ... `);
    let r;
    try {
      r = await retryOne(t);
    } catch (e) {
      if (e.unreachable) {
        console.log('FAILED');
        console.error(`\n${e.message}`);
        console.error('No further loans were attempted. Start the app (or pass --base-url) and run again.');
        break;
      }
      r = { ...t, result: 'ERROR', detail: String((e && e.message) || e) };
    }
    console.log(r.result);
    if (r.detail) console.log(`      ${r.detail}`);
    results.push(r);
    if (i < payable.length - 1) await sleep(delayMs);
  }

  if (results.length === 0) {
    console.log('');
    console.log('Nothing was attempted - no payment was made.');
    return;
  }

  console.log('\nResults');
  console.table(results.map((r) => ({
    loanId: r.loanId,
    amount: r.amount,
    result: r.result,
    http: r.httpStatus,
    cbsReference: r.cbsReference,
  })));
  const ok = results.filter((r) => r.result === 'SUCCESS').length;
  console.log(`Paid: ${ok} / ${payable.length}. Amount paid: ${money(results.filter((r) => r.result === 'SUCCESS').reduce((a, r) => a + r.amount, 0))}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(process.cwd(), `disbursement-retry-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ baseUrl, noSms, since, results }, null, 2));
  console.log(`Report saved to ${outFile}`);
}

main()
  .catch((e) => {
    console.error('\nFAILED:');
    console.error(String((e && e.message) || e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
