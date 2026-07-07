'use client';

import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useRequirePermission } from '@/hooks/use-require-permission';
import { usePermissions } from '@/hooks/use-permissions';
import { ArrowLeft, Loader2, Check, X, AlertTriangle, Image as ImageIcon } from 'lucide-react';
import type { MerchantPendingChangeWithDetails } from './page';

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  accountNumber: 'Account Number',
  contactPersonName: 'Contact Person',
  contactPersonPhone: 'Contact Phone',
  contactPersonEmail: 'Contact Email',
  additionalContactInfo: 'Additional Contact Info',
  bnplEnabled: 'BNPL Enabled',
  status: 'Status',
  iconUrl: 'Icon',
  merchantId: 'Merchant',
  categoryId: 'Category',
  description: 'Description',
  price: 'Price (ETB)',
  imageUrl: 'Images',
  videoUrl: 'Video URL',
  sellingOption: 'Selling Option',
  currency: 'Currency',
  stockQuantity: 'Stock Quantity',
  variants: 'Variants',
  optionGroups: 'Option Groups (Attributes)',
  type: 'Discount Type',
  value: 'Discount Value',
  buyX: 'Buy X',
  getY: 'Get Y',
  itemId: 'Item',
  minQuantity: 'Min Quantity',
  startDate: 'Start Date',
  endDate: 'End Date',
  address: 'Address',
  city: 'City',
  latitude: 'Latitude',
  longitude: 'Longitude',
};

const SKIP_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'merchant', 'category', 'discountRules', 'orderItems', 'inventoryLevels', 'combinationInventoryLevels']);

function getLabel(field: string): string {
  return FIELD_LABELS[field] || field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
}

function isImageValue(v: any): boolean {
  if (typeof v !== 'string') return false;
  return /^data:image\//i.test(v.trim()) || (/^https?:\/\//i.test(v.trim()) && /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(v.trim()));
}

function parseImages(v: any): string[] {
  if (!v) return [];
  if (typeof v === 'string') {
    const trimmed = v.trim();
    // Try JSON array
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return arr.filter((s: any) => typeof s === 'string');
      } catch { /* ignore */ }
    }
    if (trimmed) return [trimmed];
  }
  if (Array.isArray(v)) return v.filter((s: any) => typeof s === 'string');
  return [];
}

function formatSellingOption(v: string): string {
  switch (v) {
    case 'BNPL_ONLY': return 'BNPL Only';
    case 'DIRECT_ONLY': return 'Direct Payment Only';
    case 'BOTH': return 'BNPL + Direct';
    default: return v;
  }
}

function formatCurrency(n: number | string | undefined | null): string {
  const num = typeof n === 'string' ? parseFloat(n) : (n as number | undefined | null);
  if (num === null || num === undefined || Number.isNaN(Number(num))) return String(n ?? '—');
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(num)) + ' ETB';
}

function getEntityLabel(entityType: string): string {
  switch (entityType) {
    case 'Merchant': return 'Merchant';
    case 'MerchantItem': return 'Item';
    case 'MerchantDiscountRule': return 'Discount Rule';
    case 'MerchantLocation': return 'Location';
    default: return entityType;
  }
}

function getChangeTypeColor(ct: string): string {
  switch (ct) {
    case 'CREATE': return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    case 'UPDATE': return 'bg-blue-100 text-blue-800 border-blue-300';
    case 'DELETE': return 'bg-red-100 text-red-800 border-red-300';
    default: return '';
  }
}

export default function MerchantApprovalDetailClient({ change }: { change: MerchantPendingChangeWithDetails }) {
  useRequirePermission('merchants-approvals');
  const { canModule } = usePermissions();
  const canProcess = canModule('merchants-approvals', 'update') || canModule('approvals', 'update');

  const { toast } = useToast();
  const router = useRouter();
  const [processing, setProcessing] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);

  const parsedPayload = useMemo(() => {
    try { return JSON.parse(change.payload); } catch { return null; }
  }, [change.payload]);

  const data = useMemo(() => {
    if (!parsedPayload) return null;
    return parsedPayload.created || parsedPayload.updated || parsedPayload.original || null;
  }, [parsedPayload]);

  const original = useMemo(() => {
    if (!parsedPayload) return null;
    return parsedPayload.original || null;
  }, [parsedPayload]);

  const requestDescription = useMemo(() => {
    const who = change.createdBy?.fullName || change.createdBy?.email || 'Someone';
    const entity = getEntityLabel(change.entityType);
    const name = change.entityName !== '—' ? `"${change.entityName}"` : '';
    if (change.changeType === 'CREATE') return `${who} requested to create a new ${entity} ${name}`;
    if (change.changeType === 'UPDATE') return `${who} requested to update ${entity} ${name}`;
    if (change.changeType === 'DELETE') return `${who} requested to delete ${entity} ${name}`;
    return `${who} — ${change.changeType} ${entity}`;
  }, [change]);

  const handleApprove = async () => {
    setProcessing(true);
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: change.id, approved: true }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed'); }
      toast({ title: 'Approved successfully' });
      router.push('/admin/merchants-approvals');
      router.refresh();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setProcessing(false); }
  };

  const handleReject = async () => {
    if (!rejectionReason.trim()) {
      toast({ title: 'Error', description: 'Please enter a reason for rejection.', variant: 'destructive' });
      return;
    }
    setProcessing(true);
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeId: change.id, approved: false, rejectionReason: rejectionReason.trim() }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Failed'); }
      toast({ title: 'Rejected' });
      setShowRejectDialog(false);
      router.push('/admin/merchants-approvals');
      router.refresh();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally { setProcessing(false); }
  };

  const renderFieldValue = (field: string, value: any): React.ReactNode => {
    if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;

    // Images
    if (field === 'imageUrl' || field === 'iconUrl') {
      const images = parseImages(value);
      if (images.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-3">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img src={img} alt={`Image ${i + 1}`} className="h-20 w-20 rounded-lg border bg-white object-cover" />
              {i === 0 && images.length > 1 && (
                <span className="absolute -top-1 -right-1 bg-orange-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-medium">Main</span>
              )}
            </div>
          ))}
        </div>
      );
    }

    // Boolean  
    if (typeof value === 'boolean') return <Badge variant="outline">{value ? 'Yes' : 'No'}</Badge>;

    // Price
    if (field === 'price' || field === 'value' || field === 'priceDelta') return formatCurrency(value);

    // Selling option
    if (field === 'sellingOption') return <Badge variant="outline">{formatSellingOption(String(value))}</Badge>;

    // Status
    if (field === 'status') return <Badge variant="outline">{String(value)}</Badge>;

    // Variants array
    if (field === 'variants' && Array.isArray(value)) {
      if (value.length === 0) return <span className="text-muted-foreground">None</span>;
      return (
        <div className="border rounded-md overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Color</TableHead>
                <TableHead>Material</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {value.map((v: any, i: number) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{v.name || '—'}</TableCell>
                  <TableCell>{v.size || '—'}</TableCell>
                  <TableCell>{v.color || '—'}</TableCell>
                  <TableCell>{v.material || '—'}</TableCell>
                  <TableCell>{formatCurrency(v.price)}</TableCell>
                  <TableCell><Badge variant="outline">{v.status || 'ACTIVE'}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
    }

    // Option groups array
    if (field === 'optionGroups' && Array.isArray(value)) {
      if (value.length === 0) return <span className="text-muted-foreground">None</span>;
      return (
        <div className="space-y-3">
          {value.map((g: any, gi: number) => (
            <div key={gi} className="border rounded-md p-3">
              <div className="font-medium mb-2">{g.name}</div>
              <div className="flex flex-wrap gap-2">
                {(g.values || []).map((v: any, vi: number) => (
                  <Badge key={vi} variant="secondary">
                    {v.label}{v.priceDelta && Number(v.priceDelta) !== 0 ? ` (+${formatCurrency(v.priceDelta)})` : ''}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    }

    // Date strings
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      try { return format(new Date(value), 'MMM dd, yyyy HH:mm'); } catch { return String(value); }
    }

    // Objects/arrays - render as formatted JSON fallback
    if (typeof value === 'object') {
      return <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-40">{JSON.stringify(value, null, 2)}</pre>;
    }

    return String(value);
  };

  // Compute the list of changed fields for UPDATE
  const changedFields = useMemo(() => {
    if (change.changeType !== 'UPDATE' || !parsedPayload?.original || !parsedPayload?.updated) return null;
    const orig = parsedPayload.original;
    const upd = parsedPayload.updated;
    const keys = new Set([...Object.keys(orig || {}), ...Object.keys(upd || {})]);
    const result: { field: string; before: any; after: any }[] = [];
    keys.forEach(k => {
      if (SKIP_FIELDS.has(k)) return;
      if (JSON.stringify(orig[k]) !== JSON.stringify(upd[k])) {
        result.push({ field: k, before: orig[k], after: upd[k] });
      }
    });
    return result;
  }, [change.changeType, parsedPayload]);

  return (
    <div className="flex-1 space-y-6 p-8 pt-6 max-w-5xl mx-auto">
      {/* Back button */}
      <Button variant="ghost" onClick={() => router.push('/admin/merchants-approvals')} className="gap-2 mb-2">
        <ArrowLeft className="h-4 w-4" /> Back to Approvals
      </Button>

      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold tracking-tight">
            {getEntityLabel(change.entityType)} — {change.changeType === 'CREATE' ? 'New' : change.changeType === 'DELETE' ? 'Delete' : 'Update'} Request
          </h2>
          <Badge className={getChangeTypeColor(change.changeType)}>
            {change.changeType}
          </Badge>
          <Badge variant={change.status === 'PENDING' ? 'default' : change.status === 'APPROVED' ? 'secondary' : 'destructive'}>
            {change.status}
          </Badge>
        </div>
        <p className="text-muted-foreground">{requestDescription}</p>
        <p className="text-sm text-muted-foreground">
          Submitted on {format(new Date(change.createdAt), 'MMMM dd, yyyy \'at\' HH:mm')}
        </p>
      </div>

      {/* Rejection reason banner */}
      {change.status === 'REJECTED' && change.rejectionReason && (
        <Card className="border-destructive bg-red-50">
          <CardContent className="pt-4 pb-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
            <div>
              <div className="font-medium text-destructive">Rejection Reason</div>
              <p className="text-sm mt-1">{change.rejectionReason}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* CREATE detail */}
      {change.changeType === 'CREATE' && data && (
        <Card>
          <CardHeader>
            <CardTitle>New {getEntityLabel(change.entityType)} Details</CardTitle>
            <CardDescription>The following {getEntityLabel(change.entityType).toLowerCase()} will be created upon approval.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(data).filter(([k]) => !SKIP_FIELDS.has(k)).map(([field, value]) => (
                <div key={field} className="grid grid-cols-3 gap-4 py-2 border-b last:border-b-0">
                  <div className="text-sm font-medium text-muted-foreground">{getLabel(field)}</div>
                  <div className="col-span-2">{renderFieldValue(field, value)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* UPDATE detail - show changes side by side */}
      {change.changeType === 'UPDATE' && changedFields && (
        <Card>
          <CardHeader>
            <CardTitle>Changes to {getEntityLabel(change.entityType)}</CardTitle>
            <CardDescription>Review the differences between the original and updated values.</CardDescription>
          </CardHeader>
          <CardContent>
            {changedFields.length === 0 ? (
              <p className="text-muted-foreground text-sm">No changes detected.</p>
            ) : (
              <div className="space-y-4">
                {changedFields.map(({ field, before, after }) => (
                  <div key={field} className="border rounded-md p-4">
                    <div className="text-sm font-semibold mb-3">{getLabel(field)}</div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1 font-medium">Before</div>
                        <div className="bg-red-50 p-2 rounded text-sm">{renderFieldValue(field, before)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground mb-1 font-medium">After</div>
                        <div className="bg-green-50 p-2 rounded text-sm">{renderFieldValue(field, after)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* DELETE detail */}
      {change.changeType === 'DELETE' && original && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Delete {getEntityLabel(change.entityType)}</CardTitle>
            <CardDescription>The following {getEntityLabel(change.entityType).toLowerCase()} will be permanently removed upon approval.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(original).filter(([k]) => !SKIP_FIELDS.has(k)).map(([field, value]) => (
                <div key={field} className="grid grid-cols-3 gap-4 py-2 border-b last:border-b-0">
                  <div className="text-sm font-medium text-muted-foreground">{getLabel(field)}</div>
                  <div className="col-span-2">{renderFieldValue(field, value)}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action buttons */}
      {change.status === 'PENDING' && canProcess && (
        <div className="flex gap-3 justify-end pt-4 border-t">
          <Button
            variant="destructive"
            onClick={() => setShowRejectDialog(true)}
            disabled={processing}
            className="gap-2"
          >
            <X className="h-4 w-4" /> Reject
          </Button>
          <Button
            onClick={handleApprove}
            disabled={processing}
            className="gap-2 bg-emerald-600 hover:bg-emerald-700"
          >
            {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve
          </Button>
        </div>
      )}

      {/* Rejection reason dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Change</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting this change. The maker will see this reason and can correct and resubmit.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder="Enter rejection reason..."
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)} disabled={processing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={processing || !rejectionReason.trim()}
            >
              {processing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
