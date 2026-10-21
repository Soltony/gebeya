'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Loader2, RefreshCw, RotateCcw, Send, Undo2, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { EmptyState, StatusBadge, apiRequest, dateTime, money, type AffiliateOptions } from './shared';

type Payout = {
  id: string;
  beneficiary: string;
  beneficiaryPhone: string;
  creditAccount: string;
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  status: string;
  transactionId: string | null;
  errorMessage: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  paidAt: string | null;
  affiliate: { id: string; name: string; code: string } | null;
};

type Batch = {
  id: string;
  status: string;
  source: string;
  totalGross: number;
  totalTax: number;
  totalNet: number;
  payoutCount: number;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  program: { id: string; name: string };
  payouts: Payout[];
};

type PrepareResult = {
  batchId: string | null;
  payoutCount: number;
  skippedNoAccount: number;
  skippedBelowMinimum: number;
  message: string;
};

type Confirm =
  | { action: 'SUBMIT' | 'CANCEL' | 'APPROVE_WITHDRAWAL' | 'DECLINE_WITHDRAWAL'; batch: Batch }
  | { action: 'RETRY' | 'RELEASE'; payout: Payout };

type Kind = 'ALL' | 'BATCHES' | 'WITHDRAWALS';

const STALE_SENDING_MS = 10 * 60 * 1000;
const isStuck = (p: Payout) =>
  p.status === 'SENDING' && !!p.lastAttemptAt && Date.now() - new Date(p.lastAttemptAt).getTime() > STALE_SENDING_MS;

/** Customers and agents asked for these themselves on the mini-app's Earn page. */
const isWithdrawal = (batch: Batch) => batch.source === 'SELF_SERVICE';

function batchTitle(batch: Batch) {
  if (!isWithdrawal(batch)) return `${batch.program.name} · ${dateTime(batch.createdAt)}`;
  const payout = batch.payouts[0];
  const who = payout?.affiliate ? payout.affiliate.name : 'Welcome bonus';
  return `Withdrawal · ${who} · ${dateTime(batch.createdAt)}`;
}

export function PayoutsTab({
  options,
  canUpdate,
  canReview,
}: {
  options: AffiliateOptions;
  canUpdate: boolean;
  canReview: boolean;
}) {
  const { toast } = useToast();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [waitingForReview, setWaitingForReview] = useState(0);
  const [kind, setKind] = useState<Kind>('ALL');
  const [loading, setLoading] = useState(true);
  const [programId, setProgramId] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ batches: Batch[]; waitingForReview: number }>(
        `/api/affiliates/payouts${kind === 'ALL' ? '' : `?kind=${kind}`}`
      );
      setBatches(res.batches);
      setWaitingForReview(res.waitingForReview);
    } catch (error: any) {
      toast({ title: 'Could not load payouts', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!programId && options.programs.length) setProgramId(options.programs[0].id);
  }, [options.programs, programId]);

  const prepare = async () => {
    if (!programId) return;
    setPreparing(true);
    try {
      const result = await apiRequest<PrepareResult>('/api/affiliates/payouts', {
        method: 'POST',
        body: JSON.stringify({ action: 'PREPARE', programId }),
      });
      const skipped: string[] = [];
      if (result.skippedNoAccount) skipped.push(`${result.skippedNoAccount} without a payout account`);
      if (result.skippedBelowMinimum) skipped.push(`${result.skippedBelowMinimum} below the minimum`);
      toast({
        title: result.batchId ? 'Draft prepared' : 'Nothing to pay',
        description: `${result.message}${skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''}`,
      });
      if (result.batchId) setExpanded((e) => ({ ...e, [result.batchId!]: true }));
      await load();
    } catch (error: any) {
      toast({ title: 'Could not prepare payouts', description: error.message, variant: 'destructive' });
    } finally {
      setPreparing(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const body =
        'batch' in confirm
          ? {
              action: confirm.action,
              batchId: confirm.batch.id,
              ...(confirm.action === 'DECLINE_WITHDRAWAL' ? { reason: declineReason.trim() } : {}),
            }
          : { action: confirm.action, payoutId: confirm.payout.id };
      const result = await apiRequest<{ status?: string; message?: string }>('/api/affiliates/payouts', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const messages: Record<Confirm['action'], string> = {
        SUBMIT: 'Sent for approval. The money is sent right after a checker approves it.',
        CANCEL: 'Draft cancelled. Its commissions go into the next batch.',
        RETRY: result.message ?? 'Retry sent.',
        RELEASE: 'Released. Its commissions go into the next batch.',
        APPROVE_WITHDRAWAL: 'Approved. The money is being sent to the account shown.',
        DECLINE_WITHDRAWAL: 'Declined. Nothing was paid; the earnings are available again.',
      };
      if (confirm.action === 'RETRY' && result.status === 'FAILED') {
        toast({ title: 'Transfer failed again', description: messages.RETRY, variant: 'destructive' });
      } else {
        toast({ title: confirm.action === 'RETRY' ? 'Paid' : 'Done', description: messages[confirm.action] });
      }
      setConfirm(null);
      await load();
    } catch (error: any) {
      toast({ title: 'Action failed', description: error.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (() => {
    if (!confirm) return { title: '', body: '', action: '' };
    switch (confirm.action) {
      case 'SUBMIT':
        return {
          title: `Submit ${money(confirm.batch.totalNet)} ETB for approval?`,
          body: `${confirm.batch.payoutCount} payout(s) for ${confirm.batch.program.name}. Another user must approve them on the Approvals page before any money is sent.`,
          action: 'Submit for approval',
        };
      case 'CANCEL':
        return {
          title: 'Cancel this draft?',
          body: 'Nothing is paid. The commissions return to "ready to pay" and go into the next batch.',
          action: 'Cancel draft',
        };
      case 'RETRY':
        return {
          title: `Send ${money(confirm.payout.netAmount)} ETB again?`,
          body: 'Check with the bank first that the earlier attempt did not go through. If it did, retrying pays the affiliate twice.',
          action: 'I checked, send again',
        };
      case 'RELEASE':
        return {
          title: 'Release this payout?',
          body: 'Use this when the transfer did not go through and should not be retried now (for example a wrong account). Its commissions go into the next batch.',
          action: 'Release',
        };
      case 'APPROVE_WITHDRAWAL': {
        const p = confirm.batch.payouts[0];
        return {
          title: `Send ${money(confirm.batch.totalNet)} ETB to account ${p?.creditAccount ?? ''}?`,
          body: `${p?.affiliate?.name ?? 'This customer'} (${p?.beneficiaryPhone ?? ''}) asked to withdraw their earnings. The money is sent right away through the core banking system.`,
          action: 'Approve and send',
        };
      }
      case 'DECLINE_WITHDRAWAL':
        return {
          title: 'Decline this withdrawal?',
          body: 'Nothing is paid. The earnings become available again, so the person can withdraw later or be paid in a payout batch. The reason is kept in the audit log; the customer only sees "Declined".',
          action: 'Decline',
        };
    }
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Payouts group the commissions that are ready to pay, one transfer per person. Every batch needs approval, then the money is
          sent through the core banking system. Programs on a weekly or monthly schedule get draft batches automatically. Withdrawals
          are asked for by customers and agents on the mini-app&apos;s Earn page; large ones wait here for a checker.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All payouts</SelectItem>
              <SelectItem value="BATCHES">Payout batches</SelectItem>
              <SelectItem value="WITHDRAWALS">Withdrawals</SelectItem>
            </SelectContent>
          </Select>
          {canUpdate && (
            <>
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="Choose a program" />
                </SelectTrigger>
                <SelectContent>
                  {options.programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => void prepare()} disabled={!programId || preparing}>
                {preparing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />}
                Prepare payouts now
              </Button>
            </>
          )}
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {waitingForReview > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
          <span>
            {waitingForReview} withdrawal{waitingForReview === 1 ? ' is' : 's are'} waiting for review
            {canReview ? '.' : ' by a checker (Update on Approvals).'}
          </span>
          {kind !== 'WITHDRAWALS' && (
            <Button size="sm" variant="outline" onClick={() => setKind('WITHDRAWALS')}>
              Show withdrawals
            </Button>
          )}
        </div>
      )}

      {!batches.length ? (
        <Card>
          <CardContent>
            <EmptyState
              title={loading ? 'Loading…' : 'No payout batches yet'}
              hint={loading ? undefined : 'Prepare a batch once commissions are ready to pay.'}
            />
          </CardContent>
        </Card>
      ) : (
        batches.map((batch) => {
          const withdrawal = isWithdrawal(batch);
          const reviewable = withdrawal && batch.status === 'PENDING_APPROVAL';
          const open =
            expanded[batch.id] ?? (batch.status === 'DRAFT' || batch.status === 'PARTIAL' || reviewable);
          return (
            <Card key={batch.id} className={reviewable ? 'border-sky-300' : undefined}>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{batchTitle(batch)}</CardTitle>
                    <CardDescription>
                      {withdrawal
                        ? `Asked for in the mini-app · ${batch.program.name}`
                        : `${batch.source === 'SCHEDULED' ? 'Prepared by the schedule' : 'Prepared manually'} · ${batch.payoutCount} payout(s)`}{' '}
                      · gross {money(batch.totalGross)} · tax {money(batch.totalTax)} · <strong>net {money(batch.totalNet)} ETB</strong>
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={batch.status} />
                    {canReview && reviewable && (
                      <>
                        <Button size="sm" onClick={() => setConfirm({ action: 'APPROVE_WITHDRAWAL', batch })}>
                          <Check className="mr-2 h-4 w-4" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setDeclineReason('');
                            setConfirm({ action: 'DECLINE_WITHDRAWAL', batch });
                          }}
                        >
                          <X className="mr-2 h-4 w-4" /> Decline
                        </Button>
                      </>
                    )}
                    {canUpdate && batch.status === 'DRAFT' && (
                      <>
                        <Button size="sm" onClick={() => setConfirm({ action: 'SUBMIT', batch })}>
                          <Send className="mr-2 h-4 w-4" /> Submit for approval
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setConfirm({ action: 'CANCEL', batch })}>
                          <X className="mr-2 h-4 w-4" /> Cancel draft
                        </Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => ({ ...e, [batch.id]: !open }))}>
                      {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>
                {batch.status === 'PENDING_APPROVAL' && (
                  <p className="text-sm text-sky-700">
                    {withdrawal
                      ? 'Above the automatic limit: waiting for a checker to approve or decline it here.'
                      : 'Waiting for a checker on the Approvals page.'}
                  </p>
                )}
                {batch.status === 'PARTIAL' && (
                  <p className="text-sm text-amber-700">Some transfers failed. Check them with the bank, then retry or release them below.</p>
                )}
              </CardHeader>
              {open && (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead>Paid to</TableHead>
                          <TableHead>Account</TableHead>
                          <TableHead className="text-right">Gross</TableHead>
                          <TableHead className="text-right">Tax</TableHead>
                          <TableHead className="text-right">Net</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Details</TableHead>
                          {canUpdate && <TableHead />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {batch.payouts.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell>
                              <div className="font-medium">{p.affiliate ? p.affiliate.name : 'New customer'}</div>
                              <div className="text-xs text-muted-foreground">{p.beneficiaryPhone}</div>
                            </TableCell>
                            <TableCell className="font-mono text-xs">{p.creditAccount}</TableCell>
                            <TableCell className="text-right">{money(p.grossAmount)}</TableCell>
                            <TableCell className="text-right">{money(p.taxAmount)}</TableCell>
                            <TableCell className="text-right font-medium">{money(p.netAmount)}</TableCell>
                            <TableCell>
                              <StatusBadge status={isStuck(p) ? 'FAILED' : p.status} />
                            </TableCell>
                            <TableCell className="max-w-[260px] text-xs text-muted-foreground">
                              {p.transactionId && <div>Txn {p.transactionId}</div>}
                              {p.paidAt && <div>Paid {dateTime(p.paidAt)}</div>}
                              {p.errorMessage && <div className="text-red-600">{p.errorMessage}</div>}
                              {isStuck(p) && <div className="text-red-600">No answer from the bank. Check before retrying.</div>}
                            </TableCell>
                            {canUpdate && (
                              <TableCell className="text-right">
                                {(p.status === 'FAILED' || isStuck(p)) && (
                                  <div className="flex justify-end gap-1">
                                    <Button size="sm" variant="outline" onClick={() => setConfirm({ action: 'RETRY', payout: p })}>
                                      <RotateCcw className="mr-1 h-4 w-4" /> Retry
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setConfirm({ action: 'RELEASE', payout: p })}>
                                      <Undo2 className="mr-1 h-4 w-4" /> Release
                                    </Button>
                                  </div>
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              )}
            </Card>
          );
        })
      )}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmText.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {confirm?.action === 'DECLINE_WITHDRAWAL' && (
            <Textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="Reason (kept in the audit log)"
              rows={3}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
              disabled={busy || (confirm?.action === 'DECLINE_WITHDRAWAL' && declineReason.trim().length < 3)}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirmText.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
