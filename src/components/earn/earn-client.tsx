'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  Coins,
  Clock,
  Copy,
  Gift,
  Loader2,
  PauseCircle,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatPoints, normalizeReferralCode } from '@/lib/affiliate/config';
import { customCodeProblem, type EarningState, type PaymentState } from '@/lib/affiliate/earn-rules';
import type { EarnEarning, EarnOverview, EarnPayment, FriendProgress } from '@/lib/affiliate/earn';
import type { WithdrawalOffer } from '@/lib/affiliate/withdrawals';
import { cn } from '@/lib/utils';
import { PointPayments, PointsActions } from './points-actions';

async function callEarnApi<T>(init?: RequestInit): Promise<T> {
  const res = await fetch('/api/earn', {
    cache: 'no-store',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Something went wrong. Please try again.');
  return data as T;
}

/** Clipboard API first; the textarea fallback covers super-app web views without it. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

const day = (iso: string) => format(new Date(iso), 'd MMM yyyy');

const signed = (amount: number) => (amount > 0 ? `+${formatMoney(amount)}` : formatMoney(amount));
const signedPoints = (points: number) => (points > 0 ? `+${formatPoints(points)}` : formatPoints(points));

/** An earnings row in its own unit: points rows in points, money rows in ETB. */
const earningAmount = (earning: EarnEarning) => (earning.points != null ? signedPoints(earning.points) : signed(earning.amount));

type Pill = { label: string; className: string };

const FRIEND_PILLS: Record<FriendProgress, Pill> = {
  JOINED: { label: 'Joined', className: 'bg-gray-100 text-gray-700' },
  ORDERED: { label: 'Ordered', className: 'bg-blue-100 text-blue-800' },
  BORROWED: { label: 'Has a loan', className: 'bg-amber-100 text-amber-800' },
  REPAID: { label: 'Repaid', className: 'bg-emerald-100 text-emerald-800' },
  NOT_COUNTED: { label: 'Not counted', className: 'bg-red-50 text-red-700' },
};

const EARNING_PILLS: Record<EarningState, Pill> = {
  ON_HOLD: { label: 'On hold', className: 'bg-amber-100 text-amber-800' },
  AVAILABLE: { label: 'Available', className: 'bg-emerald-100 text-emerald-800' },
  BEING_PAID: { label: 'Being paid', className: 'bg-blue-100 text-blue-800' },
  PAID: { label: 'Paid', className: 'bg-gray-100 text-gray-700' },
  CREDITED: { label: 'Added', className: 'bg-emerald-100 text-emerald-800' },
  CANCELLED: { label: 'Cancelled', className: 'bg-red-50 text-red-700' },
  TAKEN_BACK: { label: 'Taken back', className: 'bg-red-50 text-red-700' },
};

const PAYMENT_PILLS: Record<PaymentState, Pill> = {
  PAID: { label: 'Paid', className: 'bg-emerald-100 text-emerald-800' },
  PROCESSING: { label: 'Processing', className: 'bg-blue-100 text-blue-800' },
  IN_REVIEW: { label: 'Being checked', className: 'bg-blue-100 text-blue-800' },
  DELAYED: { label: 'Delayed', className: 'bg-amber-100 text-amber-800' },
  DECLINED: { label: 'Declined', className: 'bg-red-50 text-red-700' },
  RETURNED: { label: 'Not sent', className: 'bg-gray-100 text-gray-700' },
};

function paymentNote(payment: EarnPayment): string {
  switch (payment.state) {
    case 'PAID':
      return payment.tax > 0 ? `Tax ${formatMoney(payment.tax)} deducted` : 'Paid to your account';
    case 'PROCESSING':
      return 'Being sent to your account';
    case 'IN_REVIEW':
      return 'The bank checks it before sending';
    case 'DELAYED':
      return 'The bank is checking this payment';
    case 'DECLINED':
      return 'Declined. The money is back in your balance';
    case 'RETURNED':
      return 'Not sent. The money is back in your balance';
  }
}

function StatePill({ pill }: { pill: Pill }) {
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap border-transparent font-medium', pill.className)}>
      {pill.label}
    </Badge>
  );
}

function earningNote(earning: EarnEarning): string {
  const points = earning.points != null;
  switch (earning.state) {
    case 'ON_HOLD':
      return earning.availableFrom ? `Available from ${day(earning.availableFrom)}` : 'On hold';
    case 'AVAILABLE':
      return 'Paid in the next payout';
    case 'BEING_PAID':
      return 'Being paid to your account';
    case 'PAID':
      return 'Paid to your account';
    case 'CREDITED':
      return 'Added to your points';
    case 'CANCELLED':
      return earning.reason ?? 'Cancelled';
    case 'TAKEN_BACK':
      return `${earning.reason ? `${earning.reason} ` : ''}${points ? 'Removed from your points.' : 'Deducted from your earnings.'}`;
  }
}

function Notice({ tone, icon: Icon, children }: { tone: 'amber' | 'blue'; icon: typeof AlertTriangle; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-lg border p-3 text-sm',
        tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900'
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function ChangeCodeDialog({
  open,
  onOpenChange,
  current,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: string;
  onChanged: (code: string) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setValue('');
      setError(null);
    }
  }, [open]);

  const save = async () => {
    const code = normalizeReferralCode(value);
    const problem = customCodeProblem(code);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await callEarnApi<{ code: string }>({ method: 'POST', body: JSON.stringify({ action: 'CHANGE_CODE', code }) });
      onChanged(result.code);
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Choose your code</DialogTitle>
          <DialogDescription>
            You can change your code only once. Your current code {current} will stop working, so share the new one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
            maxLength={12}
            placeholder="e.g. ABEBE2026"
            autoCapitalize="characters"
            className="font-mono uppercase tracking-widest"
          />
          <p className="text-xs text-muted-foreground">4 to 12 letters or numbers, with at least one letter.</p>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || value.length < 4}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save code
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type WithdrawResult = { net: number; account: string | null; inReview: boolean };

function WithdrawDialog({
  open,
  onOpenChange,
  offer,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offer: WithdrawalOffer;
  onDone: (result: WithdrawResult) => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      onDone(await callEarnApi<WithdrawResult>({ method: 'POST', body: JSON.stringify({ action: 'WITHDRAW' }) }));
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
          <DialogTitle>Withdraw your earnings</DialogTitle>
          <DialogDescription>
            The money goes to {offer.account === 'your accounts' ? 'your accounts' : `your account ${offer.account}`}.
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-1.5 rounded-lg bg-gray-50 p-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Earnings</dt>
            <dd>{formatMoney(offer.gross)}</dd>
          </div>
          {offer.tax > 0 && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tax</dt>
              <dd>−{formatMoney(offer.tax)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t pt-1.5 font-semibold">
            <dt>You receive</dt>
            <dd>{formatMoney(offer.net)}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          {offer.needsReview
            ? 'The bank checks this amount before sending it, usually within a working day.'
            : 'The money is sent right away.'}
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button className="bg-shop text-gray-900 hover:bg-shop-dark" onClick={() => void submit()} disabled={sending}>
            {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Withdraw {formatMoney(offer.net)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

export function EarnClient({ borrowerId }: { borrowerId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [data, setData] = useState<EarnOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [changingCode, setChangingCode] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [friendSearch, setFriendSearch] = useState('');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await callEarnApi<EarnOverview>());
    } catch (e: any) {
      setLoadError(e.message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push(`/loan?borrowerId=${encodeURIComponent(borrowerId)}`);
  };

  const join = async () => {
    setJoining(true);
    try {
      const result = await callEarnApi<{ code: string }>({ method: 'POST', body: JSON.stringify({ action: 'JOIN' }) });
      toast({ title: 'Your code is ready', description: `Share ${result.code} with your friends.` });
      await load();
    } catch (e: any) {
      toast({ title: 'Could not get your code', description: e.message, variant: 'destructive' });
    } finally {
      setJoining(false);
    }
  };

  const onWithdrawn = (result: WithdrawResult) => {
    toast(
      result.inReview
        ? { title: 'Withdrawal requested', description: `The bank checks it before sending ${formatMoney(result.net)}.` }
        : { title: 'Withdrawal on its way', description: `${formatMoney(result.net)} is being sent to your account ${result.account ?? ''}.` }
    );
    void load();
    // The transfer finishes a moment after the request; show its result.
    window.setTimeout(() => void load(), 5000);
  };

  const copyCode = async (code: string) => {
    const ok = await copyText(code);
    toast(ok ? { title: 'Code copied' } : { title: 'Could not copy', description: `Your code is ${code}.`, variant: 'destructive' });
  };

  const shareCode = async (code: string) => {
    const offer = data?.program?.friendOffer;
    const text = `Use my code ${code} when you join the app.${offer ? ` ${offer}` : ''}`;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return;
        // Sharing isn't allowed in this web view: copy the message instead.
      }
    }
    const ok = await copyText(text);
    toast(
      ok
        ? { title: 'Message copied', description: 'Paste it in any chat to share your code.' }
        : { title: 'Could not share', description: `Your code is ${code}.`, variant: 'destructive' }
    );
  };

  const filteredFriends = useMemo(() => {
    const items = data?.friends.items ?? [];
    const q = friendSearch.replace(/\D/g, '');
    return q ? items.filter((f) => f.phone.includes(q)) : items;
  }, [data, friendSearch]);

  const affiliate = data?.affiliate ?? null;
  const program = data?.program ?? null;
  const hasRewards = !!data && (data.earnings.length > 0 || data.payments.length > 0);
  const wallet = data?.points ?? null;
  const showPoints = !!wallet && (!!affiliate || hasRewards || wallet.balance !== 0);
  const showMoney = !!data?.showMoney && (!!affiliate || hasRewards);
  const pointsProgram = program?.rewardType === 'POINTS';
  const showUsed = !!data?.pointsUse && (data.pointsUse.transfers.length > 0 || showPoints);
  const tabCount = (affiliate ? 1 : 0) + 1 + (showMoney ? 1 : 0) + (showUsed ? 1 : 0);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100/80">
      <div className="bg-shop px-4 pb-5 pt-3 shadow-md sm:pt-4">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              className="-ml-1.5 rounded-full p-1.5 text-white/90 transition-colors hover:bg-white/15 hover:text-white"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Earn</h1>
          </div>
          <p className="mt-0.5 pl-8 text-sm text-white/90">Invite friends and earn rewards.</p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {!data && !loadError && <LoadingState />}

        {loadError && (
          <Card>
            <CardContent className="space-y-3 p-5 text-center">
              <p className="text-sm text-red-600">{loadError}</p>
              <Button variant="outline" onClick={() => void load()}>
                <RefreshCw className="mr-2 h-4 w-4" /> Try again
              </Button>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            {affiliate?.suspended && (
              <Notice tone="amber" icon={AlertTriangle}>
                Your code is on hold while the bank reviews your account. Your earnings are kept.
              </Notice>
            )}
            {affiliate && program?.paused && !affiliate.suspended && (
              <Notice tone="blue" icon={PauseCircle}>
                The program is paused, so friends can&apos;t use codes right now. Earnings you already have are kept.
              </Notice>
            )}

            {affiliate && (
              <Card className="border-shop/40 shadow-sm">
                <CardContent className="p-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your code</div>
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                    <div className="font-mono text-3xl font-bold tracking-widest text-gray-900">{affiliate.code}</div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => void copyCode(affiliate.code)}>
                        <Copy className="mr-1.5 h-4 w-4" /> Copy
                      </Button>
                      <Button
                        size="sm"
                        className="bg-shop text-gray-900 hover:bg-shop-dark"
                        onClick={() => void shareCode(affiliate.code)}
                        disabled={affiliate.suspended}
                      >
                        <Share2 className="mr-1.5 h-4 w-4" /> Share
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Friends enter this code in the app.
                    {!affiliate.isCustomer && ` ${affiliate.typeLabel} code.`}
                    {affiliate.canChangeCode && (
                      <button
                        type="button"
                        onClick={() => setChangingCode(true)}
                        className="ml-1 inline-flex items-center gap-1 font-medium text-shop-deep hover:underline"
                      >
                        <Pencil className="h-3 w-3" /> Change code
                      </button>
                    )}
                  </p>
                </CardContent>
              </Card>
            )}

            {!affiliate && data.join && (
              <Card className="border-shop/50 bg-shop-soft/60 shadow-sm">
                <CardContent className="p-5 text-center">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-shop text-white shadow">
                    <Gift className="h-6 w-6" />
                  </div>
                  <h2 className="text-lg font-bold text-gray-900">Invite friends, earn rewards</h2>
                  {program?.headline && <p className="mt-1 text-sm text-gray-700">{program.headline}</p>}
                  {data.join.eligible ? (
                    <Button
                      className="mt-4 w-full bg-shop text-gray-900 hover:bg-shop-dark sm:w-auto"
                      onClick={() => void join()}
                      disabled={joining}
                    >
                      {joining && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Get my code
                    </Button>
                  ) : (
                    <div className="mt-4 space-y-1.5 rounded-lg bg-white/80 p-3 text-left text-sm text-amber-900">
                      {data.join.reasons.map((reason) => (
                        <p key={reason} className="flex gap-2">
                          <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{reason}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {showPoints && wallet && (
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm text-muted-foreground">Your points</div>
                      <div
                        className={cn('text-3xl font-bold tracking-tight', wallet.balance < 0 ? 'text-red-600' : 'text-gray-900')}
                      >
                        {formatPoints(wallet.balance)}
                      </div>
                      {wallet.balance > 0 && (
                        <div className="text-sm text-muted-foreground">≈ {formatMoney(wallet.balance * wallet.pointValue)}</div>
                      )}
                    </div>
                    <Coins className="h-6 w-6 text-shop-deep" />
                  </div>
                  {wallet.balance < 0 && (
                    <p className="mt-1 text-xs text-red-600">Points that were taken back are recovered from your next points.</p>
                  )}
                  <div className="mt-3 border-t pt-3 text-sm">
                    <div className="text-muted-foreground">On hold</div>
                    <div className="font-semibold">{formatPoints(wallet.onHold)}</div>
                    {wallet.nextReleaseAt && (
                      <div className="text-xs text-muted-foreground">Next from {day(wallet.nextReleaseAt)}</div>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{wallet.note}</p>
                  {data.pointsUse && !affiliate?.suspended && (
                    <PointsActions options={data.pointsUse} balance={wallet.balance} borrowerId={borrowerId} onDone={() => void load()} />
                  )}
                </CardContent>
              </Card>
            )}

            {showMoney && (
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm text-muted-foreground">Available</div>
                      <div
                        className={cn(
                          'text-3xl font-bold tracking-tight',
                          data.balances.available < 0 ? 'text-red-600' : 'text-gray-900'
                        )}
                      >
                        {formatMoney(data.balances.available)}
                      </div>
                    </div>
                    <Wallet className="h-6 w-6 text-shop-deep" />
                  </div>
                  {data.balances.available < 0 && (
                    <p className="mt-1 text-xs text-red-600">A take-back is being recovered from your next earnings.</p>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-sm">
                    <div>
                      <div className="text-muted-foreground">On hold</div>
                      <div className="font-semibold">{formatMoney(data.balances.onHold)}</div>
                      {data.balances.nextReleaseAt && (
                        <div className="text-xs text-muted-foreground">Next from {day(data.balances.nextReleaseAt)}</div>
                      )}
                    </div>
                    <div>
                      <div className="text-muted-foreground">Paid to you</div>
                      <div className="font-semibold">{formatMoney(data.balances.paidOut)}</div>
                    </div>
                  </div>
                  {data.balances.beingPaid > 0 && (
                    <p className="mt-2 text-xs text-blue-700">
                      {formatMoney(data.balances.beingPaid)} is being paid to your account now.
                    </p>
                  )}
                  {data.withdraw && (
                    <div className="mt-3 border-t pt-3">
                      {data.withdraw.reason ? (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs text-muted-foreground">{data.withdraw.reason}</p>
                          <Button size="sm" variant="outline" disabled>
                            <Banknote className="mr-1.5 h-4 w-4" /> Withdraw
                          </Button>
                        </div>
                      ) : (
                        <Button className="w-full bg-shop text-gray-900 hover:bg-shop-dark" onClick={() => setWithdrawing(true)}>
                          <Banknote className="mr-2 h-4 w-4" /> Withdraw {formatMoney(data.withdraw.net)}
                        </Button>
                      )}
                    </div>
                  )}
                  {program && !pointsProgram && <p className="mt-2 text-xs text-muted-foreground">{program.payoutNote}</p>}
                </CardContent>
              </Card>
            )}

            {affiliate && (
              <Card className="shadow-sm">
                <CardContent className="grid grid-cols-2 gap-3 p-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Earned this month</div>
                    <div className="text-lg font-semibold">
                      {pointsProgram ? formatPoints(data.thisMonth.earnedPoints) : formatMoney(data.thisMonth.earned)}
                    </div>
                    {pointsProgram && data.thisMonth.earned > 0 && (
                      <div className="text-xs text-muted-foreground">and {formatMoney(data.thisMonth.earned)} in money</div>
                    )}
                    {program?.monthlyCap != null && program.monthlyCap > 0 && (() => {
                      // The cap is set in Birr; points programs show it in points.
                      const cap = pointsProgram ? Math.round(program.monthlyCap * program.pointsPerBirr) : program.monthlyCap;
                      const earned = pointsProgram ? data.thisMonth.earnedPoints : data.thisMonth.earned;
                      return (
                        <>
                          <Progress value={Math.min(100, (earned / cap) * 100)} className="mt-2 h-1.5" />
                          <div className="mt-1 text-xs text-muted-foreground">
                            Limit {pointsProgram ? formatPoints(cap) : formatMoney(cap)} a month
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  <div>
                    <div className="text-muted-foreground">Friends joined</div>
                    <div className="text-lg font-semibold">
                      {data.thisMonth.friendsJoined} <span className="text-sm font-normal text-muted-foreground">this month</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{data.friends.total} in total</div>
                  </div>
                </CardContent>
              </Card>
            )}

            {(affiliate || hasRewards) && (
              <Tabs defaultValue={affiliate ? 'friends' : 'earnings'}>
                <TabsList
                  className={cn(
                    'grid w-full',
                    tabCount === 4 ? 'grid-cols-4' : tabCount === 3 ? 'grid-cols-3' : tabCount === 2 ? 'grid-cols-2' : 'grid-cols-1'
                  )}
                >
                  {affiliate && <TabsTrigger value="friends">Friends ({data.friends.total})</TabsTrigger>}
                  <TabsTrigger value="earnings">{pointsProgram ? 'History' : 'Earnings'}</TabsTrigger>
                  {showUsed && <TabsTrigger value="used">Used</TabsTrigger>}
                  {showMoney && <TabsTrigger value="payments">Payments</TabsTrigger>}
                </TabsList>

                {showUsed && data.pointsUse && (
                  <TabsContent value="used">
                    <PointPayments transfers={data.pointsUse.transfers} />
                  </TabsContent>
                )}

                {affiliate && (
                  <TabsContent value="friends" className="space-y-2">
                    {data.friends.items.length > 10 && (
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={friendSearch}
                          onChange={(e) => setFriendSearch(e.target.value)}
                          placeholder="Search by last digits"
                          inputMode="numeric"
                          className="bg-white pl-9"
                        />
                      </div>
                    )}
                    {data.friends.items.length === 0 ? (
                      <p className="rounded-lg border bg-white p-6 text-center text-sm text-muted-foreground">
                        No friends yet. Share your code to get started.
                      </p>
                    ) : (
                      <ul className="divide-y rounded-lg border bg-white">
                        {filteredFriends.map((friend) => (
                          <li key={friend.id} className="flex items-center justify-between gap-3 p-3">
                            <div className="min-w-0">
                              <div className="font-medium">•••• {friend.phone}</div>
                              <div className="text-xs text-muted-foreground">Joined {day(friend.joinedAt)}</div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <StatePill pill={FRIEND_PILLS[friend.progress]} />
                              {friend.earnedPoints !== 0 && (
                                <span className={cn('text-sm font-semibold', friend.earnedPoints < 0 ? 'text-red-600' : 'text-emerald-700')}>
                                  {signedPoints(friend.earnedPoints)}
                                </span>
                              )}
                              {friend.earned !== 0 && (
                                <span className={cn('text-sm font-semibold', friend.earned < 0 ? 'text-red-600' : 'text-emerald-700')}>
                                  {signed(friend.earned)}
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                        {filteredFriends.length === 0 && (
                          <li className="p-4 text-center text-sm text-muted-foreground">No friend matches those digits.</li>
                        )}
                      </ul>
                    )}
                    {data.friends.total > data.friends.items.length && (
                      <p className="text-xs text-muted-foreground">
                        Showing your latest {data.friends.items.length} of {data.friends.total} friends.
                      </p>
                    )}
                  </TabsContent>
                )}

                <TabsContent value="earnings">
                  {data.earnings.length === 0 ? (
                    <p className="rounded-lg border bg-white p-6 text-center text-sm text-muted-foreground">
                      {pointsProgram ? 'No points yet. You earn points when your friends use the app.' : 'No earnings yet. You earn when your friends use the app.'}
                    </p>
                  ) : (
                    <ul className="divide-y rounded-lg border bg-white">
                      {data.earnings.map((earning) => (
                        <li key={earning.id} className="flex items-start justify-between gap-3 p-3">
                          <div className="min-w-0">
                            <div className="font-medium">{earning.title}</div>
                            <div className="text-xs text-muted-foreground">
                              {day(earning.date)} · {earningNote(earning)}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span
                              className={cn(
                                'text-sm font-semibold',
                                earning.state === 'CANCELLED'
                                  ? 'text-muted-foreground line-through'
                                  : (earning.points ?? earning.amount) < 0
                                    ? 'text-red-600'
                                    : 'text-gray-900'
                              )}
                            >
                              {earningAmount(earning)}
                            </span>
                            <StatePill pill={EARNING_PILLS[earning.state]} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                {showMoney && (
                <TabsContent value="payments">
                  {data.payments.length === 0 ? (
                    <p className="rounded-lg border bg-white p-6 text-center text-sm text-muted-foreground">
                      No payments yet. {program?.payoutNote ?? ''}
                    </p>
                  ) : (
                    <ul className="divide-y rounded-lg border bg-white">
                      {data.payments.map((payment) => (
                        <li key={payment.id} className="flex items-start justify-between gap-3 p-3">
                          <div className="min-w-0">
                            <div className="font-medium">{payment.withdrawal ? 'Withdrawal' : 'Payment to your account'}</div>
                            <div className="text-xs text-muted-foreground">
                              {day(payment.date)} · {paymentNote(payment)}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className="text-sm font-semibold">{formatMoney(payment.amount)}</span>
                            <StatePill pill={PAYMENT_PILLS[payment.state]} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>
                )}
              </Tabs>
            )}

            {program && (affiliate || data.join) && (
              <Card className="shadow-sm">
                <CardContent className="p-4">
                  <h2 className="mb-3 text-sm font-semibold text-gray-900">How it works</h2>
                  <ul className="space-y-2 text-sm text-gray-700">
                    {program.howItWorks.map((line) => (
                      <li key={line} className="flex gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-shop-deep" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {!affiliate && !data.join && !hasRewards && (
              <Card>
                <CardContent className="p-6 text-center text-sm text-muted-foreground">
                  Nothing here yet. When the bank runs an invite program, you&apos;ll find it here.
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>

      {data?.withdraw && !data.withdraw.reason && (
        <WithdrawDialog open={withdrawing} onOpenChange={setWithdrawing} offer={data.withdraw} onDone={onWithdrawn} />
      )}

      {affiliate && (
        <ChangeCodeDialog
          open={changingCode}
          onOpenChange={setChangingCode}
          current={affiliate.code}
          onChanged={(code) => {
            toast({ title: 'Code changed', description: `Your new code is ${code}.` });
            void load();
          }}
        />
      )}
    </div>
  );
}
