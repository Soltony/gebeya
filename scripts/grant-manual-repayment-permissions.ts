/**
 * Grants the manual repayment module's permissions to existing roles.
 *
 * Role permissions are a JSON blob keyed by the sidebar entry's `permissionKey`
 * (falling back to its kebab-cased label). A role that predates a new menu entry
 * has no key for it, and the middleware's menu read-check runs for every role —
 * Super Admin included — so until a key exists the new pages bounce back for
 * everyone.
 *
 * This writes two keys:
 *   manual-repayment      Maker: record repayments, read the report, request reversals
 *   repayment-approvals   Checker: approve, reject and decide reversals
 *
 * Usage:
 *   npx tsx -r tsconfig-paths/register scripts/grant-manual-repayment-permissions.ts
 *   npx tsx -r tsconfig-paths/register scripts/grant-manual-repayment-permissions.ts --apply
 *   npx tsx -r tsconfig-paths/register scripts/grant-manual-repayment-permissions.ts --apply --role "Branch"
 *
 * Without --apply it is a dry run and only prints what it would change.
 */

import prisma from '../src/lib/prisma';
import { CHECKER_MODULE, MAKER_MODULE } from '../src/lib/manual-repayment-access';

type Grant = { create: boolean; read: boolean; update: boolean; delete: boolean; approve?: boolean };

const NONE: Grant = { create: false, read: false, update: false, delete: false };
const FULL: Grant = { create: true, read: true, update: true, delete: true, approve: true };
const MAKER: Grant = { create: true, read: true, update: true, delete: false };
const CHECKER: Grant = { create: false, read: true, update: true, delete: false, approve: true };
const READ_ONLY: Grant = { create: false, read: true, update: false, delete: false };

/**
 * What each known role gets. A role not listed is left untouched unless named
 * with --role, in which case it gets the read-only report.
 */
const BY_ROLE: Record<string, { maker: Grant; checker: Grant }> = {
  'Super Admin': { maker: FULL, checker: FULL },
  'Loan Manager': { maker: READ_ONLY, checker: CHECKER },
  Auditor: { maker: READ_ONLY, checker: READ_ONLY },
  Branch: { maker: MAKER, checker: NONE },
  Reconciliation: { maker: READ_ONLY, checker: READ_ONLY },
  Merchant: { maker: NONE, checker: NONE },
  'Loan Provider': { maker: NONE, checker: NONE },
};

function parseArgs(argv: string[]) {
  const apply = argv.includes('--apply');
  const roleIndex = argv.indexOf('--role');
  const role = roleIndex >= 0 ? argv[roleIndex + 1] : undefined;
  return { apply, role };
}

async function main() {
  const { apply, role } = parseArgs(process.argv.slice(2));

  const roles = await prisma.role.findMany({
    where: role ? { name: role } : undefined,
    orderBy: { name: 'asc' },
  });

  if (roles.length === 0) {
    console.log(role ? `No role named "${role}".` : 'No roles found.');
    return;
  }

  let changed = 0;

  for (const r of roles) {
    let permissions: Record<string, Grant>;
    try {
      permissions = JSON.parse(r.permissions || '{}');
    } catch {
      console.warn(`! ${r.name}: permissions are not valid JSON - skipped.`);
      continue;
    }

    if (permissions[MAKER_MODULE] && permissions[CHECKER_MODULE]) {
      console.log(`= ${r.name}: already has both keys - left as is.`);
      continue;
    }

    const preset = BY_ROLE[r.name] ?? { maker: READ_ONLY, checker: NONE };
    permissions[MAKER_MODULE] = permissions[MAKER_MODULE] ?? preset.maker;
    permissions[CHECKER_MODULE] = permissions[CHECKER_MODULE] ?? preset.checker;

    console.log(
      `${apply ? '+' : '~'} ${r.name}: ${MAKER_MODULE}=${describe(permissions[MAKER_MODULE])}, ` +
        `${CHECKER_MODULE}=${describe(permissions[CHECKER_MODULE])}`,
    );

    if (apply) {
      await prisma.role.update({
        where: { id: r.id },
        data: { permissions: JSON.stringify(permissions) },
      });
    }
    changed += 1;
  }

  console.log(
    apply
      ? `\nUpdated ${changed} role(s).`
      : `\nDry run: ${changed} role(s) would change. Re-run with --apply to write.`,
  );
}

function describe(grant: Grant) {
  const actions = (['create', 'read', 'update', 'delete', 'approve'] as const).filter(
    (a) => grant[a],
  );
  return actions.length ? actions.join('/') : 'none';
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
