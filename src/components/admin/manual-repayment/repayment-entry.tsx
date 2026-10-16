'use client';

import { useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { AlertTriangle, ArrowLeft, Loader2, Paperclip, Search, X } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  PAYMENT_SOURCES,
  PAYMENT_SOURCE_LABELS,
  type PaymentSource,
} from '@/lib/manual-repayment';
import { BalanceBreakdown, dateOnly, money, sourceLabel } from './shared';
import type { LoanSearchResult, Policy } from './types';

interface Attachment {
  name: string;
  type: (typeof ALLOWED_ATTACHMENT_TYPES)[number];
  size: number;
  data: string;
}

export function RepaymentEntry({ policy, onSubmitted }: { policy: Policy; onSubmitted: () => void }) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<LoanSearchResult[] | null>(null);
  const [selected, setSelected] = useState<LoanSearchResult | null>(null);

  const [amount, setAmount] = useState('');
  const [paymentSource, setPaymentSource] = useState<PaymentSource>('CASH');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [remarks, setRemarks] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const numericAmount = Number(amount);
  // What a single repayment may settle: the active installment's quote, which is
  // exactly what the posting engine will guard with.
  const outstanding = selected?.outstanding.payableNow ?? 0;
  const today = format(new Date(), 'yyyy-MM-dd');

  // Mirrors the server's rules so the Maker is told before submitting (BRD 3.5).
  const problems = useMemo(() => {
    if (!selected) return [];
    const list: string[] = [];
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) list.push('Enter a repayment amount.');
    if (!referenceNumber.trim()) list.push('Enter the transaction / reference number.');
    if (paymentDate > today) list.push('The payment date cannot be in the future.');
    if (numericAmount > outstanding + 0.01) {
      list.push(`The amount is more than the ${money(outstanding)} ETB due now.`);
    }
    if (policy.makerApprovalLimit != null && numericAmount > policy.makerApprovalLimit + 0.01) {
      list.push(`The amount is above your approval limit of ${money(policy.makerApprovalLimit)} ETB.`);
    }
    if (policy.requireAttachment && !attachment) list.push('Attach the receipt or bank slip.');
    return list;
  }, [selected, numericAmount, referenceNumber, paymentDate, today, outstanding, policy, attachment]);

  const search = async () => {
    if (query.trim().length < 3) {
      toast({
        title: 'Enter more characters',
        description: 'Search by loan ID, account number or telephone — at least 3 characters.',
        variant: 'destructive',
      });
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/manual-repayments/search?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Search failed.');
      setResults(data.results ?? []);
      setSelected(null);
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setIsSearching(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
      toast({
        title: 'Unsupported file',
        description: 'Attach a JPG, PNG, WEBP image or a PDF.',
        variant: 'destructive',
      });
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast({
        title: 'File too large',
        description: `The receipt must be under ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`,
        variant: 'destructive',
      });
      return;
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setAttachment({ name: file.name, type: file.type as Attachment['type'], size: file.size, data });
  };

  const resetForm = () => {
    setAmount('');
    setReferenceNumber('');
    setRemarks('');
    setAttachment(null);
    setPaymentDate(format(new Date(), 'yyyy-MM-dd'));
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/manual-repayments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          loanId: selected.loanId,
          amount: numericAmount,
          paymentSource,
          referenceNumber: referenceNumber.trim(),
          // Sent as a local calendar day; the server stores it as the payment date.
          paymentDate: new Date(`${paymentDate}T00:00:00`).toISOString(),
          remarks: remarks.trim() || null,
          attachment,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'The repayment could not be recorded.');

      toast({
        title: 'Sent for approval',
        description: `${money(numericAmount)} ETB recorded against loan ${selected.loanId}. A checker must approve it before it posts.`,
      });
      setConfirmOpen(false);
      resetForm();
      setSelected(null);
      setResults(null);
      setQuery('');
      onSubmitted();
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (selected) {
    return (
      <>
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>{selected.customerName || selected.telephone}</CardTitle>
              <CardDescription>
                Loan <span className="font-mono">{selected.loanId}</span> ·{' '}
                {selected.productName ?? 'Unknown product'} · due {dateOnly(selected.dueDate)}
                {selected.accountNumber ? ` · A/C ${selected.accountNumber}` : ''}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to results
            </Button>
          </CardHeader>
          <CardContent className="space-y-5">
            <BalanceBreakdown balance={selected.outstanding} />

            {selected.pendingEntry && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  A repayment of {money(selected.pendingEntry.amount)} ETB (ref{' '}
                  {selected.pendingEntry.referenceNumber}) is already waiting for approval on this loan.
                  Check it before recording another.
                </span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="amount">Repayment amount (ETB)</Label>
                <Input
                  id="amount"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-2 hover:underline"
                  onClick={() => setAmount(String(selected.outstanding.payableNow.toFixed(2)))}
                >
                  Use the full amount due ({money(selected.outstanding.payableNow)})
                </button>
              </div>

              <div className="space-y-2">
                <Label htmlFor="source">Payment source</Label>
                <Select value={paymentSource} onValueChange={(v) => setPaymentSource(v as PaymentSource)}>
                  <SelectTrigger id="source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {PAYMENT_SOURCE_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reference">Transaction / reference number</Label>
                <Input
                  id="reference"
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="e.g. FT26198YH98D or the cheque number"
                />
                <p className="text-xs text-muted-foreground">
                  Must be unique for {PAYMENT_SOURCE_LABELS[paymentSource]}.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="payment-date">Payment date</Label>
                <Input
                  id="payment-date"
                  type="date"
                  max={today}
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="remarks">Remarks (optional)</Label>
                <Textarea
                  id="remarks"
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Anything the checker should know about this payment…"
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="attachment">
                  Receipt / bank slip {policy.requireAttachment ? '(required)' : '(optional)'}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="attachment"
                    ref={fileInput}
                    type="file"
                    accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
                    onChange={(e) => void pickFile(e.target.files?.[0])}
                    className="max-w-sm"
                  />
                  {attachment && (
                    <Badge variant="outline" className="gap-1">
                      <Paperclip className="h-3 w-3" />
                      {attachment.name}
                      <button
                        type="button"
                        onClick={() => {
                          setAttachment(null);
                          if (fileInput.current) fileInput.current.value = '';
                        }}
                        aria-label="Remove attachment"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {problems.length > 0 && amount !== '' && (
              <ul className="space-y-1 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {problems.map((p) => (
                  <li key={p}>• {p}</li>
                ))}
              </ul>
            )}
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button variant="ghost" onClick={resetForm}>
              Clear
            </Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={problems.length > 0}>
              Submit for approval
            </Button>
          </CardFooter>
        </Card>

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send this repayment for approval?</DialogTitle>
              <DialogDescription>
                It will not touch the loan until a checker approves it. You will not be able to approve it
                yourself.
              </DialogDescription>
            </DialogHeader>
            <dl className="space-y-2 text-sm">
              <Row label="Customer" value={selected.customerName || selected.telephone} />
              <Row label="Loan" value={selected.loanId} />
              <Row label="Amount" value={`${money(numericAmount)} ETB`} />
              <Row label="Source" value={sourceLabel(paymentSource)} />
              <Row label="Reference" value={referenceNumber.trim()} />
              <Row label="Payment date" value={paymentDate} />
              <Row label="Amount due now" value={`${money(outstanding)} ETB`} />
            </dl>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Find the customer</CardTitle>
        <CardDescription>
          Search by loan ID, account number or customer telephone. Only loans with an outstanding balance
          are shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="relative flex-1 max-w-lg">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Loan ID, account number or telephone…"
              className="pl-9"
            />
          </div>
          <Button type="submit" disabled={isSearching}>
            {isSearching && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Search
          </Button>
        </form>

        {results && results.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No loan with an outstanding balance matches “{query}”.
          </p>
        )}

        {results && results.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Loan</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="text-right">Due now</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={r.loanId}>
                  <TableCell>
                    <div className="font-medium">{r.customerName || '—'}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.telephone}
                      {r.accountNumber ? ` · ${r.accountNumber}` : ''}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.loanId}</TableCell>
                  <TableCell className="text-sm">{r.productName ?? '—'}</TableCell>
                  <TableCell className="text-sm">{dateOnly(r.dueDate)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {money(r.outstanding.payableNow)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" onClick={() => setSelected(r)}>
                      Record payment
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b pb-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
