'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ban, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { EmptyState, StatusBadge, apiRequest, dateTime, money, type AffiliateOptions } from './shared';

type ReferralRow = {
  id: string;
  borrowerId: string;
  source: string;
  status: string;
  rejectedReason: string | null;
  attributedAt: string;
  affiliate: { id: string; name: string; code: string };
  program: { id: string; name: string };
  programVersion: number;
  commissionTotal: number;
};

type ReferralsResponse = { total: number; page: number; pageSize: number; referrals: ReferralRow[] };

const PAGE_SIZE = 50;

export function ReferralsTab({ options, canUpdate }: { options: AffiliateOptions; canUpdate: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<ReferralsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [programId, setProgramId] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [rejecting, setRejecting] = useState<ReferralRow | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (programId !== 'all') params.set('programId', programId);
      if (status !== 'all') params.set('status', status);
      setData(await apiRequest<ReferralsResponse>(`/api/affiliates/referrals?${params}`));
    } catch (error: any) {
      toast({ title: 'Could not load referrals', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [page, search, programId, status, toast]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);

  const reject = async () => {
    if (!rejecting) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ takenBack: number }>('/api/affiliates/referrals', {
        method: 'POST',
        body: JSON.stringify({ action: 'REJECT', referralId: rejecting.id, reason: reason.trim() }),
      });
      toast({ title: 'Referral rejected', description: `${result.takenBack} commission(s) taken back.` });
      setRejecting(null);
      setReason('');
      await load();
    } catch (error: any) {
      toast({ title: 'Could not reject', description: error.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search customer phone"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select value={programId} onValueChange={(v) => { setProgramId(v); setPage(1); }}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All programs</SelectItem>
            {options.programs.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {!data?.referrals.length ? (
            <EmptyState
              title={loading ? 'Loading…' : 'No referrals yet'}
              hint={loading ? undefined : 'A referral is recorded when a customer enters an affiliate code in the mini-app.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Affiliate</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead>Referred on</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Commissions</TableHead>
                    {canUpdate && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.referrals.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-sm">{r.borrowerId}</TableCell>
                      <TableCell>
                        <div className="font-medium">{r.affiliate.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.affiliate.code}</div>
                      </TableCell>
                      <TableCell>
                        {r.program.name} <span className="text-xs text-muted-foreground">v{r.programVersion}</span>
                      </TableCell>
                      <TableCell>{dateTime(r.attributedAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={r.status} />
                          {r.rejectedReason && <span className="max-w-[220px] text-xs text-muted-foreground">{r.rejectedReason}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{money(r.commissionTotal)}</TableCell>
                      {canUpdate && (
                        <TableCell className="text-right">
                          {r.status === 'ACTIVE' && (
                            <Button variant="ghost" size="sm" onClick={() => setRejecting(r)}>
                              <Ban className="mr-1 h-4 w-4" /> Reject
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages} · {data.total} referrals
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      <Dialog open={!!rejecting} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this referral?</DialogTitle>
            <DialogDescription>
              Use this for fraud or mistakes. It takes effect now and takes back every commission this customer earned for{' '}
              {rejecting?.affiliate.name}: unpaid ones are cancelled, paid ones are deducted from the next payout. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void reject()} disabled={busy || reason.trim().length < 3}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reject referral
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
