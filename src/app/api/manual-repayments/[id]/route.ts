/**
 * GET /api/manual-repayments/[id]
 *
 * One repayment with its full audit trail: who entered it, who decided on it,
 * when it was posted, the balance before and after, and every IP recorded along
 * the way. `?attachment=1` returns the stored receipt instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { handleApiError } from '@/lib/error-utils';
import {
  MANUAL_REPAYMENT_INCLUDE,
  serializeManualRepayment,
} from '@/lib/manual-repayment-serialize';
import { canViewRepayments } from '@/lib/manual-repayment-access';

export async function GET(req: NextRequest, { params }: { params: any }) {
  const user = await getUserFromSession();
  if (!user || !canViewRepayments(user)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const { id } = (await params) ?? {};
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  try {
    const row = await prisma.manualRepayment.findUnique({
      where: { id },
      include: MANUAL_REPAYMENT_INCLUDE,
    });
    if (!row) return NextResponse.json({ error: 'Repayment not found.' }, { status: 404 });

    // The attachment is held back from the list payload; it is fetched on demand.
    if (new URL(req.url).searchParams.get('attachment') === '1') {
      if (!row.attachmentData) {
        return NextResponse.json({ error: 'No attachment on this repayment.' }, { status: 404 });
      }
      return NextResponse.json({
        name: row.attachmentName,
        type: row.attachmentType,
        size: row.attachmentSize,
        data: row.attachmentData,
      });
    }

    const trail = await prisma.auditLog.findMany({
      where: { entity: 'ManualRepayment', entityId: id },
      orderBy: { createdAt: 'asc' },
    });

    const actorIds = [...new Set(trail.map((t) => t.actorId))];
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, fullName: true, email: true },
        })
      : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));

    return NextResponse.json({
      repayment: serializeManualRepayment(row),
      auditTrail: trail.map((t) => ({
        id: t.id,
        action: t.action,
        actorId: t.actorId,
        actorName: actorById.get(t.actorId)?.fullName ?? t.actorId,
        ipAddress: t.ipAddress,
        userAgent: t.userAgent,
        createdAt: t.createdAt.toISOString(),
        details: safeParse(t.details),
      })),
    });
  } catch (error) {
    return handleApiError(error, { operation: 'GET /api/manual-repayments/[id]' });
  }
}

function safeParse(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
