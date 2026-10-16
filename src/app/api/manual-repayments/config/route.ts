/**
 * GET  /api/manual-repayments/config — the module's policy, readable by anyone who
 *                                      can use the module (the entry form needs the
 *                                      approval limit and the receipt rule).
 * PUT  /api/manual-repayments/config — System Admin changes the policy.
 *
 * The allocation order and the overpayment rule are NOT settings here: both
 * belong to `applyBnplRepayment`, which every repayment channel shares.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { handleApiError, validationErrorResponse } from '@/lib/error-utils';
import { getManualRepaymentPolicy } from '@/lib/manual-repayment';
import {
  canConfigureModule,
  canEnterRepayment,
  canViewRepayments,
  requestActorContext,
} from '@/lib/manual-repayment-access';

const configSchema = z.object({
  makerApprovalLimit: z.number().positive().nullable(),
  requireAttachment: z.boolean(),
  notifyCustomer: z.boolean(),
});

export async function GET() {
  const user = await getUserFromSession();
  if (!user || (!canViewRepayments(user) && !canEnterRepayment(user))) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const policy = await getManualRepaymentPolicy(prisma);
    return NextResponse.json({ policy, canEdit: canConfigureModule(user) });
  } catch (error) {
    return handleApiError(error, { operation: 'GET /api/manual-repayments/config' });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !canConfigureModule(user)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const { ipAddress, userAgent } = requestActorContext(req);

  try {
    const body = configSchema.parse(await req.json());
    const before = await getManualRepaymentPolicy(prisma);

    const data = {
      makerApprovalLimit: body.makerApprovalLimit,
      requireAttachment: body.requireAttachment,
      notifyCustomer: body.notifyCustomer,
      updatedById: user.id,
    };

    await prisma.manualRepaymentConfig.upsert({
      where: { id: 'global' },
      create: { id: 'global', ...data },
      update: data,
    });

    await createAuditLog({
      actorId: user.id,
      action: 'MANUAL_REPAYMENT_POLICY_UPDATED',
      entity: 'ManualRepaymentConfig',
      entityId: 'global',
      ipAddress,
      userAgent,
      details: { before, after: body },
    });

    return NextResponse.json({ ok: true, policy: await getManualRepaymentPolicy(prisma) });
  } catch (error) {
    if (error instanceof ZodError) return validationErrorResponse(error);
    return handleApiError(error, { operation: 'PUT /api/manual-repayments/config' });
  }
}
