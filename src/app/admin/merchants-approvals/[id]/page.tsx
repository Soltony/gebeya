'use server';

import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { redirect } from 'next/navigation';
import MerchantApprovalDetailClient from './client';

const removeSensitiveFields = (obj: any): any => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeSensitiveFields);
  const out: any = {};
  for (const k of Object.keys(obj)) {
    if (k === 'password' || k.toLowerCase().includes('password') || k === 'passwordHash' || k === 'hashedPassword' || k === 'pass') continue;
    const v = obj[k];
    out[k] = (typeof v === 'object' && v !== null) ? removeSensitiveFields(v) : v;
  }
  return out;
};

const sanitizePayload = (payloadStr: string) => {
  try {
    const parsed = JSON.parse(payloadStr);
    ['created', 'updated', 'original'].forEach((p) => {
      if (parsed[p]) parsed[p] = removeSensitiveFields(parsed[p]);
    });
    return JSON.stringify(parsed);
  } catch {
    return payloadStr;
  }
};

export type MerchantPendingChangeWithDetails = {
  id: string;
  entityType: string;
  entityId: string | null;
  changeType: string;
  payload: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: {
    id: string;
    fullName: string | null;
    email: string | null;
  } | null;
  entityName: string;
};

export default async function MerchantApprovalDetailPage({ params }: { params: any }) {
  const user = await getUserFromSession();
  if (!user) redirect('/api/auth/login');

  const { id } = await params;

  const change = await prisma.pendingChange.findUnique({
    where: { id },
    include: {
      createdBy: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phoneNumber: true,
          roleId: true,
          status: true,
          createdAt: true,
        },
      },
    },
  });

  if (!change) return <div className="p-8 text-center text-muted-foreground">Change not found.</div>;

  // Derive entity name from payload
  let entityName = '—';
  try {
    const p = JSON.parse(change.payload);
    entityName = p?.created?.name || p?.updated?.name || p?.original?.name || '—';
  } catch { /* ignore */ }

  const serialised: MerchantPendingChangeWithDetails = {
    id: change.id,
    entityType: change.entityType,
    entityId: change.entityId,
    changeType: change.changeType,
    payload: sanitizePayload(change.payload),
    status: change.status,
    rejectionReason: change.rejectionReason,
    createdAt: change.createdAt.toISOString(),
    updatedAt: change.updatedAt.toISOString(),
    createdBy: change.createdBy
      ? {
          id: change.createdBy.id,
          fullName: change.createdBy.fullName,
          email: change.createdBy.email,
        }
      : null,
    entityName,
  };

  return <MerchantApprovalDetailClient change={serialised} />;
}
