"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  DIRECT_PAYMENT_FILTERS,
  directPaymentFilter,
  directPaymentMethodLabel,
  directPaymentStatusCopy,
  isResolvableDirectPaymentStatus,
} from "@/lib/direct-payment-status";

type DirectPaymentRow = {
  id: string;
  transactionId: string;
  method: string;
  status: string;
  statusDesc: string | null;
  amount: number;
  createdAt: string;
  completedAt: string | null;
  statusCheckedAt: string | null;
  order: { id: string; ref: string; status: string; channel: string };
  customer: { phone: string; name: string | null };
  merchant: { name: string; accountNumber: string | null };
  cbsReference: string | null;
  pendingApproval: { changeId: string; requestedAt: string } | null;
};

const ITEMS_PER_PAGE = 20;

const fmt = (iso: string | null) => (iso ? format(new Date(iso), "yyyy-MM-dd HH:mm") : "—");

export function StatusBadge({ status, method }: { status: string; method: string }) {
  const { label } = directPaymentStatusCopy(status, method);
  const normalized = status.toUpperCase();
  if (normalized === "COMPLETED") return <Badge className="bg-green-700 text-white">{label}</Badge>;
  if (normalized === "FAILED") return <Badge variant="destructive">{label}</Badge>;
  if (normalized === "PROCESSING") return <Badge className="bg-orange-600 text-white">{label}</Badge>;
  return <Badge className="bg-yellow-600 text-white">{label}</Badge>;
}

/**
 * Order payments (NIB USSD push and super-app gateway) on the Pending
 * Payments page. A payment the bank never reported can be marked paid with
 * the FT from the bank statement; a second user approves it.
 */
export function DirectPaymentsPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<DirectPaymentRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filter, setFilter] = useState<string>(DIRECT_PAYMENT_FILTERS[0].key);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [resolving, setResolving] = useState<DirectPaymentRow | null>(null);
  const [ftReference, setFtReference] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: String(ITEMS_PER_PAGE), status: filter });
    if (fromDate) p.set("from", fromDate);
    if (toDate) p.set("to", toDate);
    if (debouncedSearch) p.set("search", debouncedSearch);
    return p.toString();
  }, [page, filter, fromDate, toDate, debouncedSearch]);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/pending-payments/direct?${query}`);
      if (!res.ok) throw new Error("Failed to fetch order payments");
      const data = await res.json();
      setRows(data.rows || []);
      setTotalPages(Math.max(1, data.totalPages || 1));
    } catch (e: any) {
      toast({ title: "Error", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitResolve = async () => {
    if (!resolving || !ftReference.trim()) return;
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/pending-payments/direct/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directPendingPaymentId: resolving.id, ftReference: ftReference.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Resolve request failed");
      toast({ title: "Submitted", description: "Resolve request submitted for approval." });
      setResolving(null);
      setFtReference("");
      await load();
    } catch (e: any) {
      toast({ title: "Error", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentFilter = directPaymentFilter(filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by reference, order (#UMU9VF), phone, merchant or FT..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <Select
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIRECT_PAYMENT_FILTERS.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">From</span>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-[160px]" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">To</span>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-[160px]" />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Order Payments: {currentFilter.label}</CardTitle>
          <CardDescription>
            When a customer was debited but the bank never reported it, find the FT on the bank statement and mark the payment
            as paid. Another user approves it; the order is then marked delivered and the customer is notified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Merchant</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : rows.length ? (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      {fmt(r.createdAt)}
                      {r.completedAt && <div className="text-xs text-muted-foreground">Paid {fmt(r.completedAt)}</div>}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      {r.pendingApproval ? (
                        <Badge variant="outline">Pending Approval</Badge>
                      ) : (
                        <StatusBadge status={r.status} method={r.method} />
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {r.statusDesc || directPaymentStatusCopy(r.status, r.method).hint}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-mono">{r.order.ref}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.order.channel === "TELEGRAM" ? "Telegram" : "Super app"} · {r.order.status}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{r.customer.name || "—"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.customer.phone}</div>
                    </TableCell>
                    <TableCell>
                      <div>{r.merchant.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.merchant.accountNumber || "no account"}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono">{r.amount.toFixed(2)}</TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{r.transactionId}</div>
                      <div className="text-xs text-muted-foreground">
                        {directPaymentMethodLabel(r.method)}
                        {r.cbsReference ? ` · ${r.cbsReference}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!!r.pendingApproval || !isResolvableDirectPaymentStatus(r.status)}
                        onClick={() => {
                          setResolving(r);
                          setFtReference("");
                        }}
                      >
                        {r.pendingApproval ? "Pending Approval" : "Mark Paid"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center">
                    No order payments found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <CardFooter className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardFooter>
      </Card>

      <Dialog open={!!resolving} onOpenChange={(open) => !open && setResolving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Order Payment as Paid</DialogTitle>
            <DialogDescription>
              Only for a payment the customer was debited for: enter the FT reference from the bank statement. After approval
              the order is marked delivered and the customer is notified.
            </DialogDescription>
          </DialogHeader>
          {resolving && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-muted-foreground">Order:</div>
                <div className="font-mono">{resolving.order.ref}</div>
                <div className="text-muted-foreground">Customer:</div>
                <div>
                  {resolving.customer.name || "—"} <span className="font-mono">{resolving.customer.phone}</span>
                </div>
                <div className="text-muted-foreground">Merchant:</div>
                <div>{resolving.merchant.name}</div>
                <div className="text-muted-foreground">Amount:</div>
                <div>{resolving.amount.toFixed(2)} ETB</div>
                <div className="text-muted-foreground">Requested:</div>
                <div>{fmt(resolving.createdAt)}</div>
                <div className="text-muted-foreground">Our reference:</div>
                <div className="font-mono">{resolving.transactionId}</div>
                <div className="text-muted-foreground">Current status:</div>
                <div>{directPaymentStatusCopy(resolving.status, resolving.method).label}</div>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="directFtRef" className="text-right">
                  FT Reference
                </Label>
                <Input
                  id="directFtRef"
                  value={ftReference}
                  onChange={(e) => setFtReference(e.target.value)}
                  className="col-span-3 font-mono"
                  placeholder="e.g. FT252748HG7N"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(null)} disabled={isSubmitting}>
              Close
            </Button>
            <Button onClick={submitResolve} disabled={isSubmitting || !ftReference.trim()}>
              {isSubmitting ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Submitting...
                </span>
              ) : (
                "Submit for Approval"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
