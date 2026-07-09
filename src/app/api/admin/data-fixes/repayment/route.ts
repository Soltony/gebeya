import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import {
  runRepaymentDataFix,
  reopenUnderCollectedLoans,
  reclassCollectedShortfalls,
} from '@/lib/data-fixes/repayment-fix-2026-07';

/**
 * POST /api/admin/data-fixes/repayment
 *
 * One-off repayment data repair for operators WITHOUT direct SQL access to
 * the production database — the app server runs the fix through Prisma.
 *
 * Security: disabled unless the DATA_FIX_TOKEN env var is set (min 16
 * chars). Callers must send the same value in the `x-data-fix-token`
 * header. Remove the env var after the fix is done to disable the route.
 *
 * Body: { "action": "fix" | "reopen-under-collected" | "reclass-shortfalls",
 *         "commit": boolean }   — commit defaults to false (dry run).
 *
 * Typical sequence:
 *   1. { action: "fix" }                          → review dry-run report
 *   2. { action: "fix", commit: true }            → apply data repair
 *   3. { action: "reopen-under-collected", commit: true }
 *   4. (after both borrowers repaid in-app)
 *      { action: "reclass-shortfalls", commit: true }
 */
export async function POST(req: NextRequest) {
  const token = process.env.DATA_FIX_TOKEN;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const supplied = req.headers.get('x-data-fix-token') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const action = body?.action;
  const commit = body?.commit === true;

  try {
    let result: unknown;
    if (action === 'fix') {
      result = await runRepaymentDataFix(prisma, { commit });
    } else if (action === 'reopen-under-collected') {
      result = await reopenUnderCollectedLoans(prisma, { commit });
    } else if (action === 'reclass-shortfalls') {
      result = await reclassCollectedShortfalls(prisma, { commit });
    } else {
      return NextResponse.json(
        { error: 'action must be one of: fix, reopen-under-collected, reclass-shortfalls' },
        { status: 400 },
      );
    }

    await createAuditLog({
      actorId: 'data-fix-operator',
      action: 'DATA_FIX_EXECUTED',
      entity: 'LOAN',
      entityId: `repayment-fix-2026-07:${action}`,
      details: { action, commit, result },
    });

    return NextResponse.json({ action, commit, result }, { status: 200 });
  } catch (e: any) {
    console.error('[DATA_FIX] failed', { action, commit, error: e?.message || e });
    return NextResponse.json({ error: e?.message || 'Data fix failed.' }, { status: 500 });
  }
}
