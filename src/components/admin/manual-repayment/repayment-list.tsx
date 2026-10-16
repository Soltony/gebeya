'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import {
  ChevronLeft,
  ChevronRight,
  FileDown,
  FileText,
  Loader2,
  Search,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  MANUAL_REPAYMENT_STATUSES,
  MANUAL_REPAYMENT_STATUS_LABELS,
  PAYMENT_SOURCES,
  PAYMENT_SOURCE_LABELS,
  type ManualRepaymentStatus,
} from '@/lib/manual-repayment';
import { RepaymentDetailDialog } from './repayment-detail-dialog';
import { StatusBadge, dateOnly, dateTime, money, sourceLabel } from './shared';
import type { ManualRepaymentListResponse, ManualRepaymentRow } from './types';

const PAGE_SIZE = 20;
/** Exports pull one wide page rather than paging the server repeatedly. */
const EXPORT_LIMIT = 500;

export function RepaymentList({
  title,
  description,
  fixedStatuses,
  emptyMessage,
  currentUserId,
  canDecide,
  canReverse,
  refreshToken = 0,
  onChanged,
}: {
  title: string;
  description: string;
  /** When set, the status filter is fixed to these and hidden (the approval queue). */
  fixedStatuses?: ManualRepaymentStatus[];
  emptyMessage: string;
  currentUserId: string | undefined;
  canDecide: boolean;
  canReverse: boolean;
  refreshToken?: number;
  onChanged?: () => void;
}) {
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('ALL');
  const [source, setSource] = useState<string>('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [data, setData] = useState<ManualRepaymentListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const buildQuery = useCallback(
    (overrides?: { page?: number; limit?: number }) => {
      const p = new URLSearchParams();
      p.set('page', String(overrides?.page ?? page));
      p.set('limit', String(overrides?.limit ?? PAGE_SIZE));
      if (fixedStatuses?.length) p.set('status', fixedStatuses.join(','));
      else if (status !== 'ALL') p.set('status', status);
      if (source !== 'ALL') p.set('paymentSource', source);
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      if (debouncedSearch) p.set('search', debouncedSearch);
      return p.toString();
    },
    [page, fixedStatuses, status, source, from, to, debouncedSearch],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`/api/manual-repayments?${buildQuery()}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || 'Failed to load repayments.');
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) {
          toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [buildQuery, toast, refreshToken, localRefresh]);

  const rows = data?.rows ?? [];
  const summary = data?.summary ?? {};

  const totals = useMemo(() => {
    const posted = summary.APPROVED ?? { count: 0, amount: 0 };
    const pending = summary.PENDING_APPROVAL ?? { count: 0, amount: 0 };
    const rejected = summary.REJECTED ?? { count: 0, amount: 0 };
    const reversed = summary.REVERSED ?? { count: 0, amount: 0 };
    const pendingReversal = summary.PENDING_REVERSAL ?? { count: 0, amount: 0 };
    return { posted, pending, rejected, reversed, pendingReversal };
  }, [summary]);

  const fetchForExport = async () => {
    const res = await fetch(`/api/manual-repayments?${buildQuery({ page: 1, limit: EXPORT_LIMIT })}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || 'Export failed.');
    return (body.rows ?? []) as ManualRepaymentRow[];
  };

  const exportExcel = async () => {
    setIsExporting(true);
    try {
      const all = await fetchForExport();
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet('Manual Repayments');
      sheet.columns = [
        { header: 'Payment date', key: 'paymentDate', width: 14 },
        { header: 'Recorded', key: 'createdAt', width: 20 },
        { header: 'Loan ID', key: 'loanId', width: 28 },
        { header: 'Telephone', key: 'borrowerId', width: 16 },
        { header: 'Product', key: 'product', width: 22 },
        { header: 'Amount (ETB)', key: 'amount', width: 15 },
        { header: 'Source', key: 'source', width: 16 },
        { header: 'Reference', key: 'reference', width: 20 },
        { header: 'Status', key: 'status', width: 18 },
        { header: 'Maker', key: 'maker', width: 24 },
        { header: 'Checker', key: 'checker', width: 24 },
        { header: 'Balance before', key: 'before', width: 16 },
        { header: 'Balance after', key: 'after', width: 16 },
        { header: 'Posted at', key: 'postedAt', width: 20 },
        { header: 'Reason', key: 'reason', width: 40 },
      ];
      sheet.getRow(1).font = { bold: true };

      for (const r of all) {
        sheet.addRow({
          paymentDate: dateOnly(r.paymentDate),
          createdAt: dateTime(r.createdAt),
          loanId: r.loanId,
          borrowerId: r.borrowerId,
          product: r.loan?.productName ?? '',
          amount: r.amount,
          source: sourceLabel(r.paymentSource),
          status: MANUAL_REPAYMENT_STATUS_LABELS[r.status as ManualRepaymentStatus] ?? r.status,
          reference: r.referenceNumber,
          maker: r.maker?.fullName ?? '',
          checker: r.checker?.fullName ?? '',
          before: r.balanceBefore.total,
          after: r.balanceAfter ?? '',
          postedAt: dateTime(r.postedAt),
          reason: r.rejectionReason || r.reversalReason || '',
        });
      }
      sheet.getColumn('amount').numFmt = '#,##0.00';
      sheet.getColumn('before').numFmt = '#,##0.00';
      sheet.getColumn('after').numFmt = '#,##0.00';

      const buffer = await wb.xlsx.writeBuffer();
      saveAs(
        new Blob([buffer], { type: 'application/octet-stream' }),
        `Manual_Repayments_${new Date().toISOString().split('T')[0]}.xlsx`,
      );
      if (all.length === EXPORT_LIMIT) {
        toast({
          title: 'Export truncated',
          description: `Only the first ${EXPORT_LIMIT} rows were exported. Narrow the date range for the rest.`,
        });
      }
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const exportPdf = async () => {
    setIsExporting(true);
    try {
      const all = await fetchForExport();
      const win = window.open('', '_blank');
      if (!win) throw new Error('Allow pop-ups to export a PDF.');
      const escape = (v: unknown) =>
        String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
      win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title>
        <style>
          body{font-family:system-ui,Segoe UI,sans-serif;margin:24px;color:#111}
          h1{font-size:18px;margin:0 0 4px}
          p.meta{font-size:12px;color:#555;margin:0 0 16px}
          table{width:100%;border-collapse:collapse;font-size:11px}
          th,td{border:1px solid #ddd;padding:5px 6px;text-align:left}
          th{background:#f4f4f5}
          td.num{text-align:right;font-variant-numeric:tabular-nums}
        </style></head><body>
        <h1>${escape(title)}</h1>
        <p class="meta">Nib International Bank — Digital Lending Portal · generated ${escape(new Date().toLocaleString())} · ${all.length} record(s)</p>
        <table><thead><tr>
          <th>Payment date</th><th>Loan ID</th><th>Telephone</th><th>Amount</th><th>Source</th>
          <th>Reference</th><th>Status</th><th>Maker</th><th>Checker</th>
        </tr></thead><tbody>
        ${all
          .map(
            (r) => `<tr>
            <td>${escape(dateOnly(r.paymentDate))}</td>
            <td>${escape(r.loanId)}</td>
            <td>${escape(r.borrowerId)}</td>
            <td class="num">${escape(money(r.amount))}</td>
            <td>${escape(sourceLabel(r.paymentSource))}</td>
            <td>${escape(r.referenceNumber)}</td>
            <td>${escape(MANUAL_REPAYMENT_STATUS_LABELS[r.status as ManualRepaymentStatus] ?? r.status)}</td>
            <td>${escape(r.maker?.fullName ?? '')}</td>
            <td>${escape(r.checker?.fullName ?? '')}</td>
          </tr>`,
          )
          .join('')}
        </tbody></table></body></html>`);
      win.document.close();
      win.focus();
      win.print();
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setIsExporting(false);
    }
  };

  const handleChanged = () => {
    setLocalRefresh((n) => n + 1);
    onChanged?.();
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Pending approval" count={totals.pending.count} amount={totals.pending.amount} />
        <Tile label="Posted" count={totals.posted.count} amount={totals.posted.amount} />
        <Tile label="Rejected" count={totals.rejected.count} amount={totals.rejected.amount} />
        <Tile
          label="Reversed"
          count={totals.reversed.count + totals.pendingReversal.count}
          amount={totals.reversed.amount + totals.pendingReversal.amount}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={exportExcel} disabled={isExporting || !rows.length}>
                {isExporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
                Excel
              </Button>
              <Button variant="outline" size="sm" onClick={exportPdf} disabled={isExporting || !rows.length}>
                <FileText className="mr-2 h-4 w-4" />
                PDF
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Reference, loan ID or telephone…"
                className="pl-9"
              />
            </div>

            {!fixedStatuses && (
              <FilterField label="Status">
                <Select
                  value={status}
                  onValueChange={(v) => {
                    setStatus(v);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-[170px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All statuses</SelectItem>
                    {MANUAL_REPAYMENT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {MANUAL_REPAYMENT_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
            )}

            <FilterField label="Payment method">
              <Select
                value={source}
                onValueChange={(v) => {
                  setSource(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All methods</SelectItem>
                  {PAYMENT_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {PAYMENT_SOURCE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FilterField>

            <FilterField label="From">
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
                className="w-[150px]"
              />
            </FilterField>

            <FilterField label="To">
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
                className="w-[150px]"
              />
            </FilterField>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payment date</TableHead>
                <TableHead>Customer / loan</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Maker</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">
                    {emptyMessage}
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-sm">{dateOnly(r.paymentDate)}</TableCell>
                    <TableCell>
                      <div className="text-sm">{r.borrowerId}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.loanId}</div>
                    </TableCell>
                    <TableCell className="text-sm">{sourceLabel(r.paymentSource)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.referenceNumber}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{money(r.amount)}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell className="text-sm">{r.maker?.fullName ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setOpenId(r.id)}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>

        <CardFooter className="justify-between">
          <p className="text-sm text-muted-foreground">
            {data ? `${data.total} record(s)` : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || isLoading}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">
              Page {page} of {Math.max(1, data?.totalPages ?? 1)}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={isLoading || page >= (data?.totalPages ?? 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardFooter>
      </Card>

      <RepaymentDetailDialog
        repaymentId={openId}
        open={!!openId}
        onOpenChange={(v) => !v && setOpenId(null)}
        onChanged={handleChanged}
        currentUserId={currentUserId}
        canDecide={canDecide}
        canReverse={canReverse}
      />
    </>
  );
}

function Tile({ label, count, amount }: { label: string; count: number; amount: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">{money(amount)}</p>
        <p className="text-xs text-muted-foreground">{count} record(s)</p>
      </CardContent>
    </Card>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
