/**
 * Helpers for the admin affiliate API routes: permission checks and creating
 * maker-checker requests.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { AffiliateError } from './programs';

export const AFFILIATE_MODULE = 'affiliates';

type Action = 'read' | 'create' | 'update' | 'delete';
type SessionUser = NonNullable<Awaited<ReturnType<typeof getUserFromSession>>>;

export async function requireAffiliateUser(
  action: Action
): Promise<{ user: SessionUser; response?: undefined } | { user?: undefined; response: NextResponse }> {
  const user = await getUserFromSession();
  if (!user) return { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  if (!user.permissions?.[AFFILIATE_MODULE]?.[action]) {
    return { response: NextResponse.json({ error: 'Not authorized' }, { status: 403 }) };
  }
  return { user };
}

export function affiliateErrorResponse(error: unknown, operation: string) {
  if (error instanceof AffiliateError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  console.error(`[affiliates] ${operation} failed:`, error);
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
}

/**
 * Queues a change for approval. Only one pending request per entity at a time,
 * so a checker never approves an edit built on stale data.
 */
export async function createAffiliateChangeRequest(
  user: { id: string },
  input: { entityType: string; entityId?: string | null; changeType: 'CREATE' | 'UPDATE'; payload: unknown }
) {
  if (input.entityId) {
    const pending = await prisma.pendingChange.findFirst({
      where: { entityType: input.entityType, entityId: input.entityId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) throw new AffiliateError('There is already a change waiting for approval for this item.', 409);
  }

  const change = await prisma.pendingChange.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      changeType: input.changeType,
      payload: JSON.stringify(input.payload),
      status: 'PENDING',
      createdById: user.id,
    },
  });

  await createAuditLog({
    actorId: user.id,
    action: 'CHANGE_REQUEST_CREATED',
    entity: input.entityType,
    entityId: input.entityId ?? undefined,
    details: { changeRequestId: change.id, changeType: input.changeType },
  });
  return change;
}

/** Pending requests of one entity type, so lists can show "waiting for approval". */
export async function pendingRequests(entityType: string) {
  const changes = await prisma.pendingChange.findMany({
    where: { entityType, status: 'PENDING' },
    select: { id: true, entityId: true, changeType: true, payload: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return changes.map((c) => {
    let name: string | null = null;
    try {
      const data = JSON.parse(c.payload);
      name = data?.created?.name ?? data?.updated?.name ?? data?.original?.name ?? null;
    } catch {
      name = null;
    }
    return { id: c.id, entityId: c.entityId, changeType: c.changeType, name, createdAt: c.createdAt };
  });
}
