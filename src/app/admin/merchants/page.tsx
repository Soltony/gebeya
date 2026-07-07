'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { PlusCircle, AlertTriangle, Clock, RotateCcw } from 'lucide-react';
import { useRequirePermission } from '@/hooks/use-require-permission';
import Link from 'next/link';

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ETB';

interface PendingItemChange {
  id: string;
  entityType: string;
  entityId: string | null;
  changeType: string;
  payload: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}

export default function MerchantsPage() {
  useRequirePermission('merchants');
  const { toast } = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingItemChange[]>([]);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants/items');
      if (res.ok) setItems(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchPendingChanges = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants/pending-changes');
      if (res.ok) setPendingChanges(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchItems(); fetchPendingChanges(); }, [fetchItems, fetchPendingChanges]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/merchants/items?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      toast({ title: 'Item deleted' });
      fetchItems();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
  };

  // Build a map of entityId -> pending/rejected status
  const getItemApprovalStatus = (itemId: string) => {
    const pending = pendingChanges.find(c => c.entityId === itemId && c.status === 'PENDING');
    if (pending) return { status: 'PENDING', change: pending };
    const rejected = pendingChanges.find(c => c.entityId === itemId && c.status === 'REJECTED');
    if (rejected) return { status: 'REJECTED', change: rejected };
    return null;
  };

  // Find pending CREATE changes (no entityId)
  const pendingCreates = pendingChanges.filter(c => c.changeType === 'CREATE' && c.status === 'PENDING');
  const rejectedCreates = pendingChanges.filter(c => c.changeType === 'CREATE' && c.status === 'REJECTED');

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Items</h2>
        <p className="text-muted-foreground">Manage merchant items.</p>
      </div>

      <div className="flex justify-end">
        <Link href="/admin/merchants/items/new">
          <Button className="bg-orange-500 hover:bg-orange-600"><PlusCircle className="mr-2 h-4 w-4" />Add Item</Button>
        </Link>
      </div>

      {/* Rejected changes needing attention */}
      {rejectedCreates.length > 0 && (
        <Card className="border-destructive/30 bg-red-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-destructive text-lg">
              <AlertTriangle className="h-5 w-5" /> Rejected Requests
            </CardTitle>
            <CardDescription>These item creation requests were rejected. Please review the reason and resubmit.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {rejectedCreates.map(c => {
                let name = '—';
                try { const p = JSON.parse(c.payload); name = p?.created?.name || '—'; } catch {}
                return (
                  <div key={c.id} className="border rounded-lg p-4 bg-white">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{name}</span>
                        <Badge variant="destructive">Rejected</Badge>
                      </div>
                      <Link href="/admin/merchants/items/new">
                        <Button size="sm" variant="outline" className="gap-1">
                          <RotateCcw className="h-3 w-3" /> Resubmit
                        </Button>
                      </Link>
                    </div>
                    {c.rejectionReason && (
                      <div className="text-sm text-destructive bg-red-50 rounded p-2 mt-1">
                        <span className="font-medium">Reason: </span>{c.rejectionReason}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending creates */}
      {pendingCreates.length > 0 && (
        <Card className="border-amber-300/50 bg-amber-50/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-amber-700 text-lg">
              <Clock className="h-5 w-5" /> Pending Approval
            </CardTitle>
            <CardDescription>These new items are waiting for checker approval.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingCreates.map(c => {
                  let name = '—';
                  let price = '';
                  try {
                    const p = JSON.parse(c.payload);
                    name = p?.created?.name || '—';
                    if (p?.created?.price) price = formatCurrency(p.created.price);
                  } catch {}
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{name}</TableCell>
                      <TableCell><Badge className="bg-emerald-100 text-emerald-800 border-emerald-300">CREATE</Badge></TableCell>
                      <TableCell><Badge className="bg-amber-100 text-amber-800 border-amber-300">Pending Approval</Badge></TableCell>
                      <TableCell className="text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Price</TableHead>
            <TableHead>Selling Option</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Approval</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(item => {
            const approval = getItemApprovalStatus(item.id);
            return (
              <TableRow key={item.id}>
                <TableCell className="font-medium">{item.name}</TableCell>
                <TableCell>{item.merchant?.name || '-'}</TableCell>
                <TableCell>{item.category?.name || '-'}</TableCell>
                <TableCell>{formatCurrency(item.price)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={
                    item.sellingOption === 'DIRECT_ONLY' ? 'bg-emerald-50 text-emerald-700 border-emerald-300' :
                    item.sellingOption === 'BOTH' ? 'bg-blue-50 text-blue-700 border-blue-300' :
                    'bg-amber-50 text-amber-700 border-amber-300'
                  }>
                    {item.sellingOption === 'DIRECT_ONLY' ? 'Direct Only' : item.sellingOption === 'BOTH' ? 'BNPL + Direct' : 'BNPL Only'}
                  </Badge>
                </TableCell>
                <TableCell><Badge variant="outline">{item.status}</Badge></TableCell>
                <TableCell>
                  {approval?.status === 'PENDING' && (
                    <Badge className="bg-amber-100 text-amber-800 border-amber-300">Update Pending</Badge>
                  )}
                  {approval?.status === 'REJECTED' && (
                    <div>
                      <Badge variant="destructive">Update Rejected</Badge>
                      {approval.change.rejectionReason && (
                        <p className="text-xs text-destructive mt-1 max-w-[200px] truncate" title={approval.change.rejectionReason}>
                          {approval.change.rejectionReason}
                        </p>
                      )}
                    </div>
                  )}
                  {!approval && (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Link href={`/admin/merchants/items/${item.id}`}>
                    <Button size="sm" variant="outline">Edit</Button>
                  </Link>
                  <AlertDialog>
                    <AlertDialogTrigger asChild><Button size="sm" variant="destructive">Delete</Button></AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader><AlertDialogTitle>Delete {item.name}?</AlertDialogTitle><AlertDialogDescription>This will permanently delete the item and its variants.</AlertDialogDescription></AlertDialogHeader>
                      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => handleDelete(item.id)}>Delete</AlertDialogAction></AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </TableCell>
              </TableRow>
            );
          })}
          {items.length === 0 && (
            <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No items found.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
