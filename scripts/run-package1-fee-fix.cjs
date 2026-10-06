/**
 * Runs scripts/fix-package1-service-fee.sql through the app's own Prisma
 * client, for machines that can reach the database but have no sqlcmd/SSMS.
 * Nothing to install: it uses the app's node_modules and DATABASE_URL.
 *
 * Run from the app folder (the one with node_modules and .env):
 *   node scripts/run-package1-fee-fix.cjs            -> DRY RUN (nothing saved)
 *   node scripts/run-package1-fee-fix.cjs --commit   -> apply the fix
 *
 * The full report is also saved as package1-fee-fix-<dryrun|applied>-<time>.json
 * in the current folder.
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
let prismaVersion = 'unknown';
try {
  const entry = fromApp('@prisma/client');
  ({ PrismaClient } = require(entry));
  try {
    prismaVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version;
  } catch {
    // version is informational only
  }
} catch {
  console.error('Could not load @prisma/client. Run this from the app folder (the one with node_modules).');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run from the app folder that has the .env file, or set DATABASE_URL first.');
  process.exit(1);
}

const commit = process.argv.includes('--commit');
const sqlPath = path.join(__dirname, 'fix-package1-service-fee.sql');
if (!fs.existsSync(sqlPath)) {
  console.error(`SQL file not found: ${sqlPath} (keep both files in the same folder).`);
  process.exit(1);
}

let sql = fs.readFileSync(sqlPath, 'utf8');
const commitFlag = /^DECLARE @Commit BIT = 0;/m;
const showTablesFlag = /^DECLARE @ShowTables BIT = 1;/m;
if (!commitFlag.test(sql)) {
  console.error('The SQL file must contain "DECLARE @Commit BIT = 0;". Leave it at 0 and use --commit instead.');
  process.exit(1);
}
if (!showTablesFlag.test(sql)) {
  console.error('The SQL file is an older version. Copy BOTH files (the .sql and this .cjs) again.');
  process.exit(1);
}
// Only the final JSON report may come back as a result set: some Prisma
// versions return the first result of a multi-result batch, others the last.
sql = sql.replace(showTablesFlag, 'DECLARE @ShowTables BIT = 0;');
if (commit) sql = sql.replace(commitFlag, 'DECLARE @Commit BIT = 1;');

const target = url.match(/^sqlserver:\/\/([^;]+);.*?database=([^;]+)/i);
const prisma = new PrismaClient();

class NoReportError extends Error {}

function printTable(title, rows) {
  console.log(`\n${title}`);
  if (!rows || rows.length === 0) console.log('  (none)');
  else console.table(rows);
}

async function main() {
  console.log(`Database: ${target ? `${target[1]} / ${target[2]}` : '(from DATABASE_URL)'}`);
  console.log(`Prisma client: ${prismaVersion}`);
  console.log(commit ? '*** APPLYING THE FIX ***' : '*** DRY RUN - nothing will be saved ***');

  const rows = await prisma.$queryRawUnsafe(sql);
  const first = Array.isArray(rows) ? rows[0] : undefined;
  const raw = first && first.report;
  if (!raw) {
    const shape = Array.isArray(rows)
      ? `${rows.length} row(s); columns: ${first ? Object.keys(first).join(', ') : '-'}`
      : `unexpected result type: ${typeof rows}`;
    throw new NoReportError(`The script ran but no report came back (${shape}).`);
  }
  const report = JSON.parse(typeof raw === 'string' ? raw : String(raw));

  printTable('Settings used', [report.settings]);
  printTable(
    'Open Package 1 loans with no service fee',
    report.loans.map((l) => ({
      loanId: l.loanId,
      amount: l.loanAmount,
      repaid: l.repaidAmount,
      status: l.repaymentStatus,
      disbursedOn: l.disbursedOn,
      action: l.action,
      feeToAdd: l.serviceFeeToAdd,
    })),
  );
  printTable('Undelivered Package 1 orders moving to Package 3', report.undeliveredOrders);
  printTable('Summary', [{ mode: report.mode, ...report.summary }]);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(process.cwd(), `package1-fee-fix-${commit ? 'applied' : 'dryrun'}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\n${report.mode}`);
  console.log(`Report saved to ${outFile}`);
  if (!commit) console.log('If this looks right, run again with --commit to apply.');
}

main()
  .catch((e) => {
    if (e instanceof NoReportError) {
      console.error(`\n${e.message}`);
      console.error(
        commit
          ? 'The fix may or may not have been saved. Run the dry run again (without --commit): if it lists no FIX loans, it was applied.'
          : 'Nothing was saved (dry run).',
      );
    } else {
      const msg = String((e && e.message) || e);
      const sqlError = msg.match(/Message: `([^`]*)`/);
      if (sqlError) {
        console.error('\nFAILED - nothing was saved (the whole fix runs in one transaction).');
        console.error(sqlError[1]);
      } else {
        console.error('\nFAILED:');
        console.error(msg);
        if (commit) console.error('If you used --commit, run the dry run again: if it lists no FIX loans, it was applied.');
      }
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
