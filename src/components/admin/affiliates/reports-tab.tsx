'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import * as ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { AFFILIATE_TYPE_LABELS, type AffiliateType } from '@/lib/affiliate/config';
import { EmptyState, StatusBadge, apiRequest, money, type AffiliateOptions } from './shared';

type Totals = {
  referrals: number;
  customersWithLoans: number;
  nplCustomers: number;
  defaultRate: number | null;
  earnedAffiliate: number;
  earnedCustomer: number;
  reversed: number;
  takenBackAfterPayment: number;
  paid: number;
  unpaid: number;
};

type ReportResponse = {
  programs: (Totals & { id: string; name: string; status: string })[];
  affiliates: (Totals & { id: string; name: string; code: string; type: AffiliateType; status: string; program: string })[];
};

// Above this share of referred borrowers in NPL an affiliate deserves a closer look.
const DEFAULT_RATE_WARNING = 10;

function DefaultRate({ rate }: { rate: number | null }) {
  if (rate == null) return <span className="text-muted-foreground">—</span>;
  return <span className={cn('font-medium', rate >= DEFAULT_RATE_WARNING && 'text-red-600')}>{rate.toFixed(1)}%</span>;
}

export function ReportsTab({ options }: { options: AffiliateOptions }) {
  const { toast } = useToast();
  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [programId, setProgramId] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (programId !== 'all') params.set('programId', programId);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      setData(await apiRequest<ReportResponse>(`/api/affiliates/reports?${params}`));
    } catch (error: any) {
      toast({ title: 'Could not load the report', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [programId, from, to, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportExcel = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const wb = new ExcelJS.Workbook();
      const moneyColumns = [
        { header: 'Earned by affiliates', key: 'earnedAffiliate', width: 20 },
        { header: 'Welcome bonuses', key: 'earnedCustomer', width: 18 },
        { header: 'Cancelled before payment', key: 'reversed', width: 24 },
        { header: 'Taken back after payment', key: 'takenBackAfterPayment', width: 24 },
        { header: 'Paid', key: 'paid', width: 14 },
        { header: 'Not yet paid', key: 'unpaid', width: 14 },
      ];
      const quality = [
        { header: 'Referred customers', key: 'referrals', width: 18 },
        { header: 'With a loan', key: 'customersWithLoans', width: 12 },
        { header: 'Now NPL', key: 'nplCustomers', width: 10 },
        { header: 'Default rate %', key: 'defaultRate', width: 14 },
      ];

      const programs = wb.addWorksheet('Programs');
      programs.columns = [{ header: 'Program', key: 'name', width: 28 }, { header: 'Status', key: 'status', width: 12 }, ...quality, ...moneyColumns];
      data.programs.forEach((p) => programs.addRow(p));

      const affiliates = wb.addWorksheet('Affiliates');
      affiliates.columns = [
        { header: 'Affiliate', key: 'name', width: 28 },
        { header: 'Code', key: 'code', width: 12 },
        { header: 'Type', key: 'type', width: 16 },
        { header: 'Program', key: 'program', width: 24 },
        { header: 'Status', key: 'status', width: 12 },
        ...quality,
        ...moneyColumns,
      ];
      data.affiliates.forEach((a) => affiliates.addRow({ ...a, type: AFFILIATE_TYPE_LABELS[a.type] ?? a.type }));

      for (const sheet of [programs, affiliates]) sheet.getRow(1).font = { bold: true };
      const buffer = await wb.xlsx.writeBuffer();
      const suffix = [from, to].filter(Boolean).join('_to_') || 'all-time';
      saveAs(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `affiliate-report-${suffix}.xlsx`);
    } catch (error: any) {
      toast({ title: 'Export failed', description: String(error?.message ?? error), variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Program</Label>
          <Select value={programId} onValueChange={setProgramId}>
            <SelectTrigger className="w-52">
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
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button variant="outline" onClick={() => void exportExcel()} disabled={!data || exporting}>
          {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
          Export to Excel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Dates filter referrals by when the customer was referred, and money by when the commission was earned. The default rate is the
        share of referred customers with a loan who are now NPL; {DEFAULT_RATE_WARNING}% or more is shown in red.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Programs</CardTitle>
          <CardDescription>Amounts in ETB.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!data?.programs.length ? (
            <EmptyState title={loading ? 'Loading…' : 'No programs yet'} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Program</TableHead>
                    <TableHead className="text-right">Referred</TableHead>
                    <TableHead className="text-right">Default rate</TableHead>
                    <TableHead className="text-right">Earned by affiliates</TableHead>
                    <TableHead className="text-right">Welcome bonuses</TableHead>
                    <TableHead className="text-right">Cancelled / taken back</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Not yet paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.programs.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{p.name}</span>
                          <StatusBadge status={p.status} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{p.referrals}</TableCell>
                      <TableCell className="text-right">
                        <DefaultRate rate={p.defaultRate} />
                      </TableCell>
                      <TableCell className="text-right">{money(p.earnedAffiliate)}</TableCell>
                      <TableCell className="text-right">{money(p.earnedCustomer)}</TableCell>
                      <TableCell className="text-right">
                        {money(p.reversed)} / {money(p.takenBackAfterPayment)}
                      </TableCell>
                      <TableCell className="text-right">{money(p.paid)}</TableCell>
                      <TableCell className="text-right">{money(p.unpaid)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Affiliates</CardTitle>
          <CardDescription>A high default rate is the main sign of low-quality or fake referrals.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!data?.affiliates.length ? (
            <EmptyState title={loading ? 'Loading…' : 'No affiliates yet'} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Affiliate</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead className="text-right">Referred</TableHead>
                    <TableHead className="text-right">With a loan</TableHead>
                    <TableHead className="text-right">Now NPL</TableHead>
                    <TableHead className="text-right">Default rate</TableHead>
                    <TableHead className="text-right">Earned</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Not yet paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.affiliates.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted-foreground">
                          <span className="font-mono">{a.code}</span> · {AFFILIATE_TYPE_LABELS[a.type] ?? a.type}
                          {a.status !== 'ACTIVE' ? ' · suspended' : ''}
                        </div>
                      </TableCell>
                      <TableCell>{a.program}</TableCell>
                      <TableCell className="text-right">{a.referrals}</TableCell>
                      <TableCell className="text-right">{a.customersWithLoans}</TableCell>
                      <TableCell className="text-right">{a.nplCustomers}</TableCell>
                      <TableCell className="text-right">
                        <DefaultRate rate={a.defaultRate} />
                      </TableCell>
                      <TableCell className="text-right">{money(a.earnedAffiliate)}</TableCell>
                      <TableCell className="text-right">{money(a.paid)}</TableCell>
                      <TableCell className="text-right">{money(a.unpaid)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
