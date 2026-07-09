/**
 * CLI wrapper for the 2026-07 repayment data fix, for operators with shell
 * access to a machine that can reach the database (uses DATABASE_URL).
 *
 *   npx tsx -r tsconfig-paths/register scripts/run-repayment-fix.ts --action fix
 *   npx tsx -r tsconfig-paths/register scripts/run-repayment-fix.ts --action fix --commit
 *   npx tsx -r tsconfig-paths/register scripts/run-repayment-fix.ts --action reopen-under-collected --commit
 *   npx tsx -r tsconfig-paths/register scripts/run-repayment-fix.ts --action reclass-shortfalls --commit
 *
 * Without --commit every action is a dry run (changes rolled back or skipped).
 */
import 'dotenv/config';
import prisma from '@/lib/prisma';
import {
  runRepaymentDataFix,
  reopenUnderCollectedLoans,
  reclassCollectedShortfalls,
} from '@/lib/data-fixes/repayment-fix-2026-07';

async function main() {
  const args = process.argv.slice(2);
  const actionIdx = args.indexOf('--action');
  const action = actionIdx >= 0 ? args[actionIdx + 1] : 'fix';
  const commit = args.includes('--commit');

  console.log(`Running repayment data fix: action=${action} commit=${commit}`);
  let result: unknown;
  if (action === 'fix') result = await runRepaymentDataFix(prisma, { commit });
  else if (action === 'reopen-under-collected') result = await reopenUnderCollectedLoans(prisma, { commit });
  else if (action === 'reclass-shortfalls') result = await reclassCollectedShortfalls(prisma, { commit });
  else throw new Error(`Unknown action: ${action}`);

  console.log(JSON.stringify(result, null, 2));
  if (!commit) console.log('\nDRY RUN — nothing was persisted. Re-run with --commit to apply.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
