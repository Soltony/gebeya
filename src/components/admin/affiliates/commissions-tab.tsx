'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { EVENT_LABELS, formatPoints, type CommissionEvent } from '@/lib/affiliate/config';
import { EmptyState, StatusBadge, apiRequest, money, shortDate, statusLabel, type AffiliateOptions } from './shared';

type CommissionRow = {
  id: string;
  kind: string;
  status: string;
  beneficiary: string;
  beneficiaryPhone: string;
  ruleName: string | null;
  eventType: CommissionEvent;
  sourceType: string;
  sourceId: string;
  fundedBy: string;
  baseAmount: number;
  amount: number;
  rewardType: 'MONEY' | 'POINTS';
  points: number | null;
  eventDate: string;
  holdUntil: string;
  reversedReason: string | null;
  affiliate: { id: string; name: string; code: string };
  borrowerId: string;
  program: string;
  programVersion: number;
};

type CommissionsResponse = {
  total: number;
  totals: { status: string; amount: number; count: number }[];
  commissions: CommissionRow[];
};

const PAGE_SIZE = 50;
// CREDITED: points rewards added to the points wallet.
const STATUSES = ['PENDING', 'PAYABLE', 'IN_PAYOUT', 'PAID', 'CREDITED', 'REVERSED'];

export function CommissionsTab({ options }: { options: AffiliateOptions }) {
  const { toast } = useToast();
  const [data, setData] = useState<CommissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [programId, setProgramId] = useState('all');
  const [beneficiary, setBeneficiary] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status !== 'all') params.set('status', status);
      if (programId !== 'all') params.set('programId', programId);
      if (beneficiary !== 'all') params.set('beneficiary', beneficiary);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      setData(await apiRequest<CommissionsResponse>(`/api/affiliates/commissions?${params}`));
    } catch (error: any) {
      toast({ title: 'Could not load commissions', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [page, status, programId, beneficiary, from, to, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Commissions are recorded by the daily job. They stay on hold for the program&apos;s hold period, then become ready to pay.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={resetPage(setStatus)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Program</Label>
          <Select value={programId} onValueChange={resetPage(setProgramId)}>
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
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Paid to</Label>
          <Select value={beneficiary} onValueChange={resetPage(setBeneficiary)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everyone</SelectItem>
              <SelectItem value="AFFILIATE">Affiliates</SelectItem>
              <SelectItem value="CUSTOMER">New customers</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} className="w-40" />
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {data && data.totals.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {STATUSES.map((s) => {
            const t = data.totals.find((x) => x.status === s);
            return (
              <div key={s} className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">{statusLabel(s)}</div>
                <div className="text-lg font-semibold">{money(t?.amount ?? 0)}</div>
                <div className="text-xs text-muted-foreground">{t?.count ?? 0} commission(s)</div>
              </div>
            );
          })}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {!data?.commissions.length ? (
            <EmptyState title={loading ? 'Loading…' : 'No commissions found'} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Affiliate</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead>Paid to</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ready from</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.commissions.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap">{shortDate(c.eventDate)}</TableCell>
                      <TableCell>
                        <div className="font-medium">{c.affiliate.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.program} v{c.programVersion}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.borrowerId}</TableCell>
                      <TableCell>
                        <div>{c.ruleName ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">{EVENT_LABELS[c.eventType] ?? c.eventType}</div>
                      </TableCell>
                      <TableCell>{c.beneficiary === 'AFFILIATE' ? 'Affiliate' : 'New customer'}</TableCell>
                      <TableCell className={`text-right font-medium ${c.amount < 0 ? 'text-red-600' : ''}`}>
                        {money(c.amount)}
                        {c.rewardType === 'POINTS' && <div className="text-xs font-normal">{formatPoints(c.points)}</div>}
                        {c.kind === 'CLAWBACK' && <div className="text-xs font-normal">taken back</div>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={c.status} />
                          {c.reversedReason && <span className="max-w-[200px] text-xs text-muted-foreground">{c.reversedReason}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{c.status === 'PENDING' ? shortDate(c.holdUntil) : '—'}</TableCell>
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
            Page {page} of {totalPages} · {data.total} commissions
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
