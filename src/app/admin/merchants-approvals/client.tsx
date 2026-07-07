'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRequirePermission } from '@/hooks/use-require-permission';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Eye, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

interface ChangeRow {
  id: string;
  entityType: string;
  entityId: string | null;
  changeType: string;
  payload: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; fullName: string | null; email: string | null } | null;
}

export function MerchantApprovalsClient({ changes: initial }: { changes: ChangeRow[] }) {
  useRequirePermission('merchants-approvals');
  const router = useRouter();
  const [changes] = useState(initial);

  const getPayloadSummary = (c: ChangeRow) => {
    try {
      const p = JSON.parse(c.payload);
      return p?.created?.name || p?.updated?.name || p?.name || '—';
    } catch { return '—'; }
  };

  const getEntityLabel = (entityType: string) => {
    switch (entityType) {
      case 'Merchant': return 'Merchant';
      case 'MerchantItem': return 'Item';
      case 'MerchantDiscountRule': return 'Discount Rule';
      case 'MerchantLocation': return 'Location';
      default: return entityType;
    }
  };

  const getChangeTypeColor = (ct: string) => {
    switch (ct) {
      case 'CREATE': return 'bg-emerald-100 text-emerald-800 border-emerald-300';
      case 'UPDATE': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'DELETE': return 'bg-red-100 text-red-800 border-red-300';
      default: return '';
    }
  };

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <h2 className="text-3xl font-bold tracking-tight">Merchant Pending Approvals</h2>
      <Card>
        <CardHeader>
          <CardTitle>Change Requests</CardTitle>
          <CardDescription>Review and approve or reject merchant changes. Click on a request to view full details.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Requested By</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No pending approvals.</TableCell></TableRow>
              )}
              {changes.map(c => (
                <TableRow key={c.id} className="cursor-pointer hover:bg-muted/50" onClick={() => router.push(`/admin/merchants-approvals/${c.id}`)}>
                  <TableCell><Badge className={getChangeTypeColor(c.changeType)}>{c.changeType}</Badge></TableCell>
                  <TableCell>{getEntityLabel(c.entityType)}</TableCell>
                  <TableCell className="font-medium">{getPayloadSummary(c)}</TableCell>
                  <TableCell>{c.createdBy?.fullName || c.createdBy?.email || '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</TableCell>
                  <TableCell><Badge>{c.status}</Badge></TableCell>
                  <TableCell className="text-right">
                    <Link href={`/admin/merchants-approvals/${c.id}`} onClick={e => e.stopPropagation()}>
                      <Button variant="outline" size="sm" className="gap-2">
                        <Eye className="h-4 w-4" /> Review
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
