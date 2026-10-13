/**
 * Runs one of the .sql fix scripts in this folder through the app's own Prisma
 * client, for machines that can reach the database but have no sqlcmd/SSMS.
 *
 * Run from the app folder (the one with node_modules and .env):
 *   node scripts/run-sql-fix.cjs --file fix-inclusive-tax-on-gross-paid-loans.sql
 *   node scripts/run-sql-fix.cjs --file fix-inclusive-tax-on-gross-paid-loans.sql --commit
 *
 * Without --commit the script runs as a dry run and saves nothing. The report
 * is also written to <file>-<dryrun|applied>-<time>.json in the current folder.
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
const commit = argv.includes('--commit');
const fileArg = (() => {
  const i = argv.indexOf('--file');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--file='));
  return eq ? eq.slice(7) : null;
})();

if (!fileArg) {
  console.error('Which script? Example:');
  console.error('  node scripts/run-sql-fix.cjs --file fix-inclusive-tax-on-gross-paid-loans.sql');
  process.exit(1);
}

const sqlPath = path.isAbsolute(fileArg) ? fileArg : path.join(__dirname, fileArg);
if (!fs.existsSync(sqlPath)) {
  console.error(`SQL file not found: ${sqlPath}`);
  process.exit(1);
}

let sql = fs.readFileSync(sqlPath, 'utf8');
const commitFlag = /^DECLARE @Commit BIT = 0;/m;
const showTablesFlag = /^DECLARE @ShowTables BIT = 1;/m;
if (!commitFlag.test(sql) || !showTablesFlag.test(sql)) {
  console.error('That file is not a fix script of the expected shape (needs @Commit and @ShowTables). Copy the latest version.');
  process.exit(1);
}
// Only the final JSON report may come back: some Prisma versions return the
// first result of a multi-result batch, others the last.
sql = sql.replace(showTablesFlag, 'DECLARE @ShowTables BIT = 0;');
if (commit) sql = sql.replace(commitFlag, 'DECLARE @Commit BIT = 1;');

const prisma = new PrismaClient();
const target = process.env.DATABASE_URL.match(/^sqlserver:\/\/([^;]+);.*?database=([^;]+)/i);

class NoReportError extends Error {}

async function main() {
  console.log(`Database: ${target ? `${target[1]} / ${target[2]}` : '(from DATABASE_URL)'}`);
  console.log(`Script:   ${path.basename(sqlPath)}`);
  console.log(commit ? '*** APPLYING ***' : '*** DRY RUN - nothing will be saved ***');

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

  for (const [key, section] of Object.entries(report)) {
    if (key === 'mode') continue;
    console.log(`\n${key}`);
    if (Array.isArray(section)) {
      if (section.length === 0) console.log('  (none)');
      else console.table(section);
    } else if (section && typeof section === 'object') {
      console.table([section]);
    } else {
      console.log(`  ${section}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(sqlPath, '.sql');
  const outFile = path.join(process.cwd(), `${base}-${commit ? 'applied' : 'dryrun'}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\n${report.mode}`);
  console.log(`Report saved to ${outFile}`);
  if (!commit) console.log('If this looks right, run again with --commit to apply.');
}

main()
  .catch((e) => {
    if (e instanceof NoReportError) {
      console.error(`\n${e.message}`);
      console.error(commit
        ? 'It may or may not have been saved. Run the dry run again: if it lists no FIX rows, it was applied.'
        : 'Nothing was saved (dry run).');
    } else {
      const msg = String((e && e.message) || e);
      const sqlError = msg.match(/Message: `([^`]*)`/);
      console.error('\nFAILED - nothing was saved (the whole fix runs in one transaction).');
      console.error(sqlError ? sqlError[1] : msg);
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
