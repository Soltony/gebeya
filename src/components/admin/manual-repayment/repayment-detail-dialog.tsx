'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  Loader2,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { BUCKET_LABELS, type AllocationBucket } from '@/lib/manual-repayment';
import { BalanceBreakdown, StatusBadge, dateOnly, dateTime, money, sourceLabel } from './shared';
import type { AuditTrailEntry, ManualRepaymentRow } from './types';

type PendingAction = 'approve' | 'reject' | 'request-reversal' | 'approve-reversal' | 'decline-reversal';

/** Actions that must carry a reason before they can be sent (BRD 3.6, 3.7). */
const NEEDS_REASON: PendingAction[] = ['reject', 'request-reversal', 'approve-reversal', 'decline-reversal'];

export function RepaymentDetailDialog({
  repaymentId,
  open,
  onOpenChange,
  onChanged,
  currentUserId,
  canDecide,
  canReverse,
}: {
  repaymentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  currentUserId: string | undefined;
  canDecide: boolean;
  canReverse: boolean;
}) {
  const { toast } = useToast();
  const [repayment, setRepayment] = useState<ManualRepaymentRow | null>(null);
  const [trail, setTrail] = useState<AuditTrailEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [action, setAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!repaymentId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/manual-repayments/${repaymentId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load the repayment.');
      setRepayment(data.repayment);
      setTrail(data.auditTrail ?? []);
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [repaymentId, toast]);

  useEffect(() => {
    if (open && repaymentId) {
      setAction(null);
      setReason('');
      void load();
    }
  }, [open, repaymentId, load]);

  const submit = async () => {
    if (!repayment || !action) return;
    if (NEEDS_REASON.includes(action) && reason.trim().length < 5) {
      toast({
        title: 'A reason is required',
        description: 'Enter at least 5 characters explaining the decision.',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const isDecision = action === 'approve' || action === 'reject';
      const url = isDecision
        ? `/api/manual-repayments/${repayment.id}/decision`
        : `/api/manual-repayments/${repayment.id}/reversal`;
      const body = isDecision
        ? { approved: action === 'approve', ...(action === 'reject' ? { rejectionReason: reason.trim() } : {}) }
        : {
            action:
              action === 'request-reversal'
                ? 'request'
                : action === 'approve-reversal'
                  ? 'approve'
                  : 'reject',
            reason: reason.trim(),
          };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'The request could not be completed.');

      toast({ title: 'Done', description: successMessage(action, data) });
      setAction(null);
      setReason('');
      onChanged();
      await load();
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const downloadAttachment = async () => {
    if (!repayment) return;
    try {
      const res = await fetch(`/api/manual-repayments/${repayment.id}?attachment=1`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Attachment not available.');
      const link = document.createElement('a');
      link.href = `data:${data.type};base64,${data.data}`;
      link.download = data.name || 'receipt';
      link.click();
    } catch (e) {
      toast({ title: 'Error', description: String((e as Error)?.message ?? e), variant: 'destructive' });
    }
  };

  const isOwnEntry = !!repayment?.maker && repayment.maker.id === currentUserId;
  const isOwnReversalRequest = repayment?.reversalRequestedById === currentUserId;
  const canApproveThis = canDecide && repayment?.status === 'PENDING_APPROVAL' && !isOwnEntry;
  const canRequestReversalOnThis = canReverse && repayment?.status === 'APPROVED';
  const canDecideReversal = canDecide && repayment?.status === 'PENDING_REVERSAL' && !isOwnReversalRequest;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            Manual repayment
            {repayment && <StatusBadge status={repayment.status} />}
          </DialogTitle>
          <DialogDescription>
            {repayment
              ? `${money(repayment.amount)} ETB · ${sourceLabel(repayment.paymentSource)} · Ref ${repayment.referenceNumber}`
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>

        {isLoading && !repayment ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : repayment ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Field label="Loan ID" value={repayment.loanId} mono />
              <Field label="Customer telephone" value={repayment.borrowerId} />
              <Field label="Product" value={repayment.loan?.productName ?? '—'} />
              <Field label="Payment date" value={dateOnly(repayment.paymentDate)} />
              <Field label="Payment source" value={sourceLabel(repayment.paymentSource)} />
              <Field label="Reference" value={repayment.referenceNumber} mono />
            </dl>

            {repayment.remarks && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Remarks</p>
                <p className="mt-1 whitespace-pre-wrap">{repayment.remarks}</p>
              </div>
            )}

            {repayment.attachment?.name && (
              <Button variant="outline" size="sm" onClick={downloadAttachment}>
                <Download className="mr-2 h-4 w-4" />
                {repayment.attachment.name}
              </Button>
            )}

            <BalanceBreakdown balance={repayment.balanceBefore} title="Balance before posting" />

            {repayment.allocation && (
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  How the repayment was applied
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
                  {(Object.keys(BUCKET_LABELS) as AllocationBucket[]).map((bucket) => (
                    <div key={bucket} className="flex flex-col">
                      <dt className="text-xs text-muted-foreground">{BUCKET_LABELS[bucket]}</dt>
                      <dd className="tabular-nums">{money(repayment.allocation?.[bucket])}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-sm">
                  Balance after posting:{' '}
                  <span className="font-semibold tabular-nums">{money(repayment.balanceAfter)} ETB</span>
                </p>
              </div>
            )}

            {repayment.rejectionReason && (
              <Callout tone="danger" title="Rejected">{repayment.rejectionReason}</Callout>
            )}
            {repayment.reversalReason && (
              <Callout tone="warning" title={repayment.reversedAt ? 'Reversed' : 'Reversal requested'}>
                {repayment.reversalReason}
              </Callout>
            )}

            <Separator />

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Audit trail</p>
              <ol className="mt-2 space-y-2 text-sm">
                {trail.length === 0 && <li className="text-muted-foreground">No entries recorded.</li>}
                {trail.map((entry) => (
                  <li key={entry.id} className="rounded-md border p-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{humanize(entry.action)}</span>
                      <span className="text-xs text-muted-foreground">{dateTime(entry.createdAt)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {entry.actorName} · IP {entry.ipAddress || 'N/A'}
                    </p>
                  </li>
                ))}
              </ol>
            </div>

            {action && (
              <div className="space-y-2 rounded-lg border border-dashed p-4">
                <Label htmlFor="decision-reason">
                  {action === 'reject'
                    ? 'Reason for rejection (required)'
                    : action === 'request-reversal'
                      ? 'Reason for reversal (required)'
                      : action === 'approve-reversal'
                        ? 'Confirm the reversal (required)'
                        : action === 'decline-reversal'
                          ? 'Why the reversal is declined (required)'
                          : 'Note'}
                </Label>
                {action === 'approve' ? (
                  <p className="text-sm text-muted-foreground">
                    Approving posts {money(repayment.amount)} ETB against loan {repayment.loanId} and updates
                    its balance and status. This cannot be edited afterwards — only reversed.
                  </p>
                ) : (
                  <Textarea
                    id="decision-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Explain the decision for the audit trail…"
                    rows={3}
                  />
                )}
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {canApproveThis && !action && (
              <>
                <Button onClick={() => setAction('approve')}>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Approve &amp; post
                </Button>
                <Button variant="destructive" onClick={() => setAction('reject')}>
                  Reject
                </Button>
              </>
            )}
            {canDecide && repayment?.status === 'PENDING_APPROVAL' && isOwnEntry && (
              <p className="text-sm text-muted-foreground">
                You recorded this repayment, so another checker has to approve it.
              </p>
            )}
            {canRequestReversalOnThis && !action && (
              <Button variant="outline" onClick={() => setAction('request-reversal')}>
                <Undo2 className="mr-2 h-4 w-4" />
                Request reversal
              </Button>
            )}
            {canDecideReversal && !action && (
              <>
                <Button variant="destructive" onClick={() => setAction('approve-reversal')}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  Approve reversal
                </Button>
                <Button variant="outline" onClick={() => setAction('decline-reversal')}>
                  Decline reversal
                </Button>
              </>
            )}
          </div>

          <div className="flex gap-2">
            {action && (
              <>
                <Button variant="ghost" onClick={() => setAction(null)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button onClick={submit} disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm
                </Button>
              </>
            )}
            {!action && (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? 'truncate font-mono text-xs' : 'truncate'}>{value}</dd>
    </div>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'danger' | 'warning';
  title: string;
  children: React.ReactNode;
}) {
  const classes =
    tone === 'danger'
      ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
  return (
    <div className={`rounded-md border p-3 text-sm ${classes}`}>
      <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
      <p className="mt-1 whitespace-pre-wrap">{children}</p>
    </div>
  );
}

function humanize(action: string) {
  return action
    .replace(/^MANUAL_REPAYMENT_/, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

function successMessage(action: PendingAction, data: { balanceAfter?: number }) {
  switch (action) {
    case 'approve':
      return `Posted. Outstanding balance is now ${money(data?.balanceAfter)} ETB.`;
    case 'reject':
      return 'The repayment was rejected and the maker notified in the audit trail.';
    case 'request-reversal':
      return 'The reversal was sent for approval.';
    case 'approve-reversal':
      return `Reversed. Outstanding balance is now ${money(data?.balanceAfter)} ETB.`;
    default:
      return 'The reversal request was declined; the posting stands.';
  }
}
