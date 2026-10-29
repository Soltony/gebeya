'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Banknote, Landmark, Loader2, ShoppingBag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatPoints } from '@/lib/affiliate/config';
import { birrForPoints, pointsNeeded } from '@/lib/affiliate/earn-rules';
import type { PointsUseOptions, TransferSummary } from '@/lib/affiliate/transfers';
import { cn } from '@/lib/utils';

/** One id per confirmation: the server uses it so a repeated tap never spends twice. */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function postEarn<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/earn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Something went wrong. Please try again.');
  return data as T;
}

/** The most points one use allows now: balance and today's/this month's limits. */
function maxPoints(balance: number, option: { leftToday: number | null; leftThisMonth: number | null }) {
  return Math.max(0, Math.min(balance, option.leftToday ?? Infinity, option.leftThisMonth ?? Infinity));
}

function WithdrawPointsDialog({
  open,
  onOpenChange,
  balance,
  option,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: number;
  option: PointsUseOptions['withdrawal'];
  onDone: (t: TransferSummary) => void;
}) {
  const limit = maxPoints(balance, option);
  const [points, setPoints] = useState('');
  const [requestId, setRequestId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPoints(String(limit));
      setRequestId(newRequestId());
      setError(null);
    }
  }, [open, limit]);

  const value = Number(points);
  const amount = Number.isInteger(value) && value > 0 ? birrForPoints(value, option.rate) : 0;
  const tooFew = value < option.minPoints;

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      onDone(await postEarn<TransferSummary>({ action: 'WITHDRAW_POINTS', points: value, requestId }));
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Withdraw points</DialogTitle>
          <DialogDescription>
            1 point = {option.rate} ETB. The money goes to your account {option.account}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={points}
            onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric"
            placeholder={`At least ${option.minPoints}`}
          />
          <p className="text-xs text-muted-foreground">
            From {formatPoints(option.minPoints)}, up to {formatPoints(limit)} now.
          </p>
          <div className="flex justify-between rounded-lg bg-gray-50 p-3 text-sm font-semibold">
            <span>You receive</span>
            <span>{formatMoney(amount)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {amount > option.autoApproveUpTo
              ? 'The bank checks this amount before sending it, usually within a working day.'
              : 'The money is sent right away.'}
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button
            className="bg-shop text-gray-900 hover:bg-shop-dark"
            onClick={() => void submit()}
            disabled={sending || tooFew || value > limit || !Number.isInteger(value)}
          >
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Withdraw {formatMoney(amount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepayWithPointsDialog({
  open,
  onOpenChange,
  balance,
  option,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: number;
  option: PointsUseOptions['repayment'];
  onDone: (t: TransferSummary) => void;
}) {
  const limit = maxPoints(balance, option);
  const [loanId, setLoanId] = useState('');
  const [amount, setAmount] = useState('');
  const [requestId, setRequestId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loan = option.loans.find((l) => l.id === loanId) ?? null;

  const suggested = (due: number) => Math.min(due, Math.floor(birrForPoints(limit, option.rate) * 100) / 100);
  useEffect(() => {
    if (open) {
      const first = option.loans[0];
      setLoanId(first?.id ?? '');
      setAmount(first ? String(suggested(first.due)) : '');
      setRequestId(newRequestId());
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const value = Number(amount);
  const points = value > 0 ? pointsNeeded(value, option.rate) : 0;
  const valid = !!loan && value > 0 && value <= loan.due && points >= option.minPoints && points <= limit;

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      onDone(await postEarn<TransferSummary>({ action: 'REPAY_WITH_POINTS', loanId, amount: value, requestId }));
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Pay a loan with points</DialogTitle>
          <DialogDescription>1 point = {option.rate} ETB. The payment goes straight to your loan.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            {option.loans.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  setLoanId(l.id);
                  setAmount(String(suggested(l.due)));
                }}
                className={cn(
                  'w-full rounded-lg border p-2.5 text-left text-sm transition-colors',
                  l.id === loanId ? 'border-shop bg-shop-soft/60' : 'hover:bg-gray-50'
                )}
              >
                <div className="font-medium">{l.label}</div>
                <div className="text-xs text-muted-foreground">Due now: {formatMoney(l.due)}</div>
              </button>
            ))}
          </div>
          <div className="space-y-1">
            <Input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" placeholder="Amount (ETB)" />
            <p className="text-xs text-muted-foreground">
              Uses {formatPoints(points)} (from {formatPoints(option.minPoints)}; you can use up to {formatPoints(limit)} now).
            </p>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button className="bg-shop text-gray-900 hover:bg-shop-dark" onClick={() => void submit()} disabled={sending || !valid}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Pay {formatMoney(value || 0)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Buttons under the points balance for each use the bank has switched on. */
export function PointsActions({
  options,
  balance,
  borrowerId,
  onDone,
}: {
  options: PointsUseOptions;
  balance: number;
  borrowerId: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'withdraw' | 'repay' | null>(null);
  const canRepay = options.repayment.enabled && options.repayment.loans.length > 0 && balance >= options.repayment.minPoints;
  const canWithdraw = options.withdrawal.enabled && !!options.withdrawal.account && balance >= options.withdrawal.minPoints;
  if (!options.shop.enabled && !options.repayment.enabled && !options.withdrawal.enabled) return null;

  const finished = (t: TransferSummary) => {
    const messages: Record<string, { title: string; description: string }> = {
      SUCCESS: { title: 'Done', description: `${formatMoney(t.amount)} paid with ${formatPoints(t.points)}. Reference ${t.reference}.` },
      READY: { title: 'On its way', description: `${formatMoney(t.amount)} is being sent to your account ${t.account}.` },
      SENDING: { title: 'On its way', description: `${formatMoney(t.amount)} is being sent. Reference ${t.reference}.` },
      PENDING_REVIEW: { title: 'Requested', description: `The bank checks it before sending ${formatMoney(t.amount)}.` },
      FAILED: { title: 'Not completed yet', description: `The bank is checking this payment (${t.reference}). Your points are kept until it is sorted out.` },
    };
    toast(messages[t.status] ?? { title: 'Done', description: `Reference ${t.reference}.` });
    onDone();
    window.setTimeout(onDone, 5000);
  };

  return (
    <div className="mt-3 grid grid-cols-3 gap-2 border-t pt-3">
      <Button
        asChild={options.shop.enabled}
        variant="outline"
        size="sm"
        className="h-auto flex-col gap-1 py-2"
        disabled={!options.shop.enabled}
      >
        {options.shop.enabled ? (
          <Link href={`/loan?borrowerId=${encodeURIComponent(borrowerId)}&view=shop`}>
            <ShoppingBag className="h-4 w-4" />
            Shop
          </Link>
        ) : (
          <span>
            <ShoppingBag className="h-4 w-4" />
            Shop
          </span>
        )}
      </Button>
      <Button variant="outline" size="sm" className="h-auto flex-col gap-1 py-2" disabled={!canRepay} onClick={() => setDialog('repay')}>
        <Landmark className="h-4 w-4" />
        Pay a loan
      </Button>
      <Button variant="outline" size="sm" className="h-auto flex-col gap-1 py-2" disabled={!canWithdraw} onClick={() => setDialog('withdraw')}>
        <Banknote className="h-4 w-4" />
        Withdraw
      </Button>
      {options.shop.enabled && (
        <p className="col-span-3 text-xs text-muted-foreground">In the shop, choose “Pay with points” on an item.</p>
      )}
      {options.withdrawal.enabled && (
        <WithdrawPointsDialog
          open={dialog === 'withdraw'}
          onOpenChange={(o) => setDialog(o ? 'withdraw' : null)}
          balance={balance}
          option={options.withdrawal}
          onDone={finished}
        />
      )}
      {options.repayment.enabled && (
        <RepayWithPointsDialog
          open={dialog === 'repay'}
          onOpenChange={(o) => setDialog(o ? 'repay' : null)}
          balance={balance}
          option={options.repayment}
          onDone={finished}
        />
      )}
    </div>
  );
}

const PURPOSE_LABELS: Record<string, string> = {
  SHOP: 'Shop order',
  REPAYMENT: 'Loan repayment',
  WITHDRAWAL: 'Withdrawal',
};

const STATUS_PILLS: Record<string, { label: string; className: string }> = {
  RESERVED: { label: 'Points held', className: 'bg-amber-100 text-amber-800' },
  PENDING_REVIEW: { label: 'Being checked', className: 'bg-blue-100 text-blue-800' },
  READY: { label: 'Processing', className: 'bg-blue-100 text-blue-800' },
  SENDING: { label: 'Processing', className: 'bg-blue-100 text-blue-800' },
  SUCCESS: { label: 'Done', className: 'bg-emerald-100 text-emerald-800' },
  FAILED: { label: 'Delayed', className: 'bg-amber-100 text-amber-800' },
  SENT_UNAPPLIED: { label: 'Being checked', className: 'bg-amber-100 text-amber-800' },
  CANCELLED: { label: 'Points returned', className: 'bg-gray-100 text-gray-700' },
};

/** What the person used points for, with the reference to quote to the bank. */
export function PointPayments({ transfers }: { transfers: TransferSummary[] }) {
  const items = useMemo(() => transfers.slice(0, 20), [transfers]);
  if (!items.length) {
    return <p className="rounded-lg border bg-white p-6 text-center text-sm text-muted-foreground">You haven&apos;t used points yet.</p>;
  }
  return (
    <ul className="divide-y rounded-lg border bg-white">
      {items.map((t) => {
        const pill = STATUS_PILLS[t.status] ?? { label: t.status, className: 'bg-gray-100 text-gray-700' };
        return (
          <li key={t.id} className="flex items-start justify-between gap-3 p-3">
            <div className="min-w-0">
              <div className="font-medium">{PURPOSE_LABELS[t.purpose] ?? t.purpose}</div>
              <div className="text-xs text-muted-foreground">
                {format(new Date(t.createdAt), 'd MMM yyyy')} · {formatMoney(t.amount)} to {t.account} · {t.reference}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className={cn('text-sm font-semibold', t.status === 'CANCELLED' ? 'text-muted-foreground line-through' : 'text-gray-900')}>
                -{formatPoints(t.points)}
              </span>
              <Badge variant="outline" className={cn('whitespace-nowrap border-transparent font-medium', pill.className)}>
                {pill.label}
              </Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
