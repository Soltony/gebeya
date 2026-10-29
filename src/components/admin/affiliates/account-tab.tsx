'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Landmark, Loader2, Lock, Pencil, PlusCircle, RefreshCw, RotateCcw, Search, Undo2, Unlock, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { formatPoints } from '@/lib/affiliate/config';
import { cn } from '@/lib/utils';
import { EmptyState, NumberInput, StatusBadge, apiRequest, dateTime, money } from './shared';

type Account = {
  id: string;
  name: string;
  accountNumber: string | null;
  cbsProviderId: string | null;
  effectiveCbsProviderId: string;
  balance: number;
  reserved: number;
  available: number;
  status: 'ACTIVE' | 'FROZEN';
  frozenReason: string | null;
};

type Entry = {
  id: string;
  reference: string;
  type: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: number;
  balanceAfter: number;
  counterpartyAccount: string | null;
  bankReference: string | null;
  description: string;
  createdAt: string;
};

type Transfer = {
  id: string;
  reference: string;
  purpose: 'SHOP' | 'REPAYMENT' | 'WITHDRAWAL';
  status: string;
  phone: string;
  points: number;
  pointValue: number;
  amount: number;
  creditAccount: string;
  creditAccountName: string | null;
  orderId: string | null;
  loanId: string | null;
  transactionId: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
};

type AccountResponse = {
  account: Account;
  settingsPending: boolean;
  pendingMovements: { id: string; name: string | null; createdAt: string }[];
  attention: { waitingForReview: number; failed: number; unapplied: number };
  entries: Entry[];
  transfers: Transfer[];
};

const PURPOSES: Record<Transfer['purpose'], string> = { SHOP: 'Shop order', REPAYMENT: 'Loan repayment', WITHDRAWAL: 'Withdrawal' };
const TRANSFER_STATUS_LABELS: Record<string, string> = {
  RESERVED: 'Points held',
  PENDING_REVIEW: 'Waiting for review',
  READY: 'Ready to send',
  SENDING: 'Sending',
  SUCCESS: 'Paid',
  FAILED: 'Failed',
  SENT_UNAPPLIED: 'Paid, not recorded',
  CANCELLED: 'Points returned',
};
const STUCK_MS = 10 * 60 * 1000;
const isStuck = (t: Transfer) => t.status === 'SENDING' && !!t.lastAttemptAt && Date.now() - new Date(t.lastAttemptAt).getTime() > STUCK_MS;

type Action =
  | { kind: 'APPROVE_TRANSFER' | 'RETRY_TRANSFER'; transfer: Transfer }
  | { kind: 'DECLINE_TRANSFER' | 'RELEASE_TRANSFER' | 'RESOLVE_TRANSFER' | 'CONFIRM_TRANSFER'; transfer: Transfer }
  | { kind: 'FREEZE' | 'UNFREEZE' };

const ACTION_TEXT: Record<Action['kind'], { title: string; body: string; button: string; input?: 'reason' | 'bankReference' }> = {
  APPROVE_TRANSFER: { title: 'Approve this withdrawal?', body: 'The money is sent from the affiliate account to the customer’s own account right away.', button: 'Approve and send' },
  DECLINE_TRANSFER: { title: 'Decline this withdrawal?', body: 'Nothing is paid and the customer gets their points back. The reason is kept in the audit log.', button: 'Decline', input: 'reason' },
  RETRY_TRANSFER: { title: 'Send it again?', body: 'Check with the bank first that the earlier attempt did not go through. If it did, this pays twice.', button: 'I checked, send again' },
  CONFIRM_TRANSFER: { title: 'Confirm it was paid?', body: 'Use this when the bank shows the transfer went through. Enter its FT number: the transfer is settled and, for a loan, the repayment is recorded.', button: 'Confirm paid', input: 'bankReference' },
  RELEASE_TRANSFER: { title: 'Release it?', body: 'Use this when the bank shows the transfer did not go through and it should not be retried. The customer gets their points back.', button: 'Release', input: 'reason' },
  RESOLVE_TRANSFER: { title: 'Mark as resolved?', body: 'The bank paid it but the system could not record it (for example the loan was already repaid). Fix it by hand first (manual repayment or refund), then note what you did.', button: 'Mark resolved', input: 'reason' },
  FREEZE: { title: 'Freeze the affiliate account?', body: 'Takes effect now: no shop order, loan repayment, withdrawal or payout is paid from the account until it is unfrozen (which needs approval).', button: 'Freeze now', input: 'reason' },
  UNFREEZE: { title: 'Ask to unfreeze the account?', body: 'A checker must approve it on the Approvals page before spending starts again.', button: 'Submit for approval' },
};

function SettingsDialog({ open, onOpenChange, account, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; account: Account; onDone: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(account.name);
  const [accountNumber, setAccountNumber] = useState(account.accountNumber ?? '');
  const [cbsProviderId, setCbsProviderId] = useState(account.cbsProviderId ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setName(account.name);
      setAccountNumber(account.accountNumber ?? '');
      setCbsProviderId(account.cbsProviderId ?? '');
    }
  }, [open, account]);
  const submit = async () => {
    setSaving(true);
    try {
      await apiRequest('/api/affiliates/account', {
        method: 'POST',
        body: JSON.stringify({ action: 'UPDATE_SETTINGS', name, accountNumber: accountNumber || null, cbsProviderId: cbsProviderId || null }),
      });
      toast({ title: 'Sent for approval', description: 'A checker must approve it on the Approvals page.' });
      onOpenChange(false);
      onDone();
    } catch (e: any) {
      toast({ title: 'Could not submit', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Account settings</DialogTitle>
          <DialogDescription>The core banking account the Affiliate Program pays from. Changes need approval.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Account number</Label>
            <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="e.g. 1000123456789" />
          </div>
          <div className="space-y-1">
            <Label>CBS provider id</Label>
            <Input value={cbsProviderId} onChange={(e) => setCbsProviderId(e.target.value)} placeholder={`Default: ${account.effectiveCbsProviderId}`} />
            <p className="text-xs text-muted-foreground">The id the CBS transfer API debits for this account. Empty uses the default from the server settings.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={saving || name.trim().length < 2}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MovementDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<'FUNDING' | 'ADJUSTMENT'>('FUNDING');
  const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('CREDIT');
  const [amount, setAmount] = useState<number | null>(null);
  const [bankReference, setBankReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setKind('FUNDING');
      setDirection('CREDIT');
      setAmount(null);
      setBankReference('');
      setNote('');
    }
  }, [open]);
  const valid = !!amount && amount > 0 && bankReference.trim().length >= 4 && (kind === 'FUNDING' || note.trim().length >= 3);
  const submit = async () => {
    setSaving(true);
    try {
      await apiRequest('/api/affiliates/account', {
        method: 'POST',
        body: JSON.stringify({ action: 'MOVEMENT', kind, direction: kind === 'FUNDING' ? 'CREDIT' : direction, amount, bankReference, note: note || null }),
      });
      toast({ title: 'Sent for approval', description: 'A checker must approve it on the Approvals page.' });
      onOpenChange(false);
      onDone();
    } catch (e: any) {
      toast({ title: 'Could not submit', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record money in or out</DialogTitle>
          <DialogDescription>
            Funding: money the bank paid into the account. Adjustment: brings the ledger in line with the bank statement. A checker approves it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as 'FUNDING' | 'ADJUSTMENT')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="FUNDING">Funding</SelectItem>
                  <SelectItem value="ADJUSTMENT">Adjustment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {kind === 'ADJUSTMENT' && (
              <div className="space-y-1">
                <Label>Direction</Label>
                <Select value={direction} onValueChange={(v) => setDirection(v as 'CREDIT' | 'DEBIT')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CREDIT">Into the account</SelectItem>
                    <SelectItem value="DEBIT">Out of the account</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label>Amount (ETB)</Label>
            <NumberInput value={amount} onChange={setAmount} />
          </div>
          <div className="space-y-1">
            <Label>Bank reference (FT number)</Label>
            <Input value={bankReference} onChange={(e) => setBankReference(e.target.value.toUpperCase())} placeholder="e.g. FT25300ABCDE" />
            <p className="text-xs text-muted-foreground">Each funding reference can be recorded once.</p>
          </div>
          <div className="space-y-1">
            <Label>Note {kind === 'ADJUSTMENT' ? '(why)' : '(optional)'}</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!valid || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AccountTab({ canUpdate, canReview }: { canUpdate: boolean; canReview: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<AccountResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [purpose, setPurpose] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (purpose !== 'ALL') params.set('purpose', purpose);
      if (status !== 'ALL') params.set('status', status);
      if (query) {
        params.set('transferSearch', query);
        params.set('entrySearch', query);
      }
      setData(await apiRequest<AccountResponse>(`/api/affiliates/account?${params.toString()}`));
    } catch (e: any) {
      toast({ title: 'Could not load the account', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [purpose, status, query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async () => {
    if (!action) return;
    const text = ACTION_TEXT[action.kind];
    setBusy(true);
    try {
      const body: Record<string, unknown> = { action: action.kind };
      if ('transfer' in action) body.id = action.transfer.id;
      if (text.input === 'reason') body.reason = input.trim();
      if (text.input === 'bankReference') body.bankReference = input.trim();
      const result = await apiRequest<{ status?: string; message?: string }>('/api/affiliates/account', { method: 'POST', body: JSON.stringify(body) });
      if (result.status === 'FAILED') toast({ title: 'Transfer failed again', description: result.message, variant: 'destructive' });
      else toast({ title: 'Done', description: result.message ?? text.button });
      setAction(null);
      await load();
    } catch (e: any) {
      toast({ title: 'Action failed', description: e.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const account = data?.account;
  const actionText = action ? ACTION_TEXT[action.kind] : null;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Every affiliate payment is made from this account: shop orders, loan repayments and withdrawals paid with points, and money
        payouts. Each payment holds its amount first and is debited when the bank confirms it. The balance changes only with an entry in
        the ledger below.
      </p>

      {account && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Landmark className="h-4 w-4" /> {account.name}
                    <StatusBadge status={account.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED'} />
                  </CardTitle>
                  <CardDescription>
                    Account {account.accountNumber ?? 'not set'} · CBS provider {account.effectiveCbsProviderId}
                    {!account.cbsProviderId && ' (default)'}
                  </CardDescription>
                </div>
                {canUpdate && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={data.settingsPending}>
                      <Pencil className="mr-2 h-4 w-4" /> Settings
                    </Button>
                    {account.status === 'ACTIVE' ? (
                      <Button size="sm" variant="outline" onClick={() => { setInput(''); setAction({ kind: 'FREEZE' }); }}>
                        <Lock className="mr-2 h-4 w-4" /> Freeze
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => { setInput(''); setAction({ kind: 'UNFREEZE' }); }} disabled={data.settingsPending}>
                        <Unlock className="mr-2 h-4 w-4" /> Unfreeze
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Balance</div>
                  <div className="text-lg font-semibold">{money(account.balance)} ETB</div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Held for payments in progress</div>
                  <div className="text-lg font-semibold">{money(account.reserved)} ETB</div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Available</div>
                  <div className={cn('text-lg font-semibold', account.available <= 0 && 'text-red-600')}>{money(account.available)} ETB</div>
                </div>
              </div>
              {account.status === 'FROZEN' && (
                <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
                  Frozen: nothing is paid from the account. {account.frozenReason}
                </p>
              )}
              {data.settingsPending && <p className="text-sm text-sky-700">A settings change is waiting for approval.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Money in and out</CardTitle>
              <CardDescription>Funding and adjustments, with a checker&apos;s approval.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {canUpdate && (
                <Button size="sm" onClick={() => setMoving(true)}>
                  <PlusCircle className="mr-2 h-4 w-4" /> Record funding or adjustment
                </Button>
              )}
              {data.pendingMovements.length ? (
                <ul className="space-y-1">
                  {data.pendingMovements.map((p) => (
                    <li key={p.id} className="rounded border px-2 py-1">
                      {p.name ?? 'Account movement'} <span className="text-xs text-sky-700">· waiting for approval</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">Nothing waiting for approval.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {data && (data.attention.waitingForReview > 0 || data.attention.failed > 0 || data.attention.unapplied > 0) && (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
          {data.attention.waitingForReview > 0 && <div>{data.attention.waitingForReview} withdrawal(s) waiting for review{canReview ? '' : ' by a checker'}.</div>}
          {data.attention.failed > 0 && <div>{data.attention.failed} payment(s) failed: check them with the bank, then retry, confirm paid or release.</div>}
          {data.attention.unapplied > 0 && <div>{data.attention.unapplied} payment(s) were paid by the bank but not recorded: finish them by hand.</div>}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setQuery(search.trim()); }}
            placeholder="Reference, FT number, phone, order or loan id"
            className="w-80 pl-9"
          />
        </div>
        <Button variant="outline" onClick={() => setQuery(search.trim())}>Search</Button>
        <Select value={purpose} onValueChange={setPurpose}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All uses</SelectItem>
            <SelectItem value="SHOP">Shop orders</SelectItem>
            <SelectItem value="REPAYMENT">Loan repayments</SelectItem>
            <SelectItem value="WITHDRAWAL">Withdrawals</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {Object.entries(TRANSFER_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Points payments</CardTitle>
          <CardDescription>Each use of points, paid from this account through CBS.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!data?.transfers.length ? (
            <EmptyState title={loading ? 'Loading…' : 'No points payments yet'} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Use</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Paid to</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                    <TableHead className="text-right">ETB</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Details</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.transfers.map((t) => {
                    const stuck = isStuck(t);
                    const failed = t.status === 'FAILED' || stuck;
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="whitespace-nowrap text-xs">{dateTime(t.createdAt)}</TableCell>
                        <TableCell className="font-mono text-xs">{t.reference}</TableCell>
                        <TableCell>{PURPOSES[t.purpose] ?? t.purpose}</TableCell>
                        <TableCell className="text-xs">{t.phone}</TableCell>
                        <TableCell className="text-xs">
                          <div className="font-mono">{t.creditAccount}</div>
                          {t.creditAccountName && <div className="text-muted-foreground">{t.creditAccountName}</div>}
                        </TableCell>
                        <TableCell className="text-right">{formatPoints(t.points)}</TableCell>
                        <TableCell className="text-right font-medium">{money(t.amount)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('whitespace-nowrap', failed || t.status === 'SENT_UNAPPLIED' ? 'border-red-200 bg-red-50 text-red-700' : t.status === 'SUCCESS' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-sky-200 bg-sky-50 text-sky-700')}>
                            {stuck ? 'No answer from the bank' : TRANSFER_STATUS_LABELS[t.status] ?? t.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[240px] text-xs text-muted-foreground">
                          {t.transactionId && <div>FT {t.transactionId}</div>}
                          {t.orderId && <div>Order {t.orderId}</div>}
                          {t.loanId && <div>Loan {t.loanId}</div>}
                          {t.errorMessage && <div className="text-red-600">{t.errorMessage}</div>}
                          {t.cancelReason && <div>{t.cancelReason}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {canReview && t.status === 'PENDING_REVIEW' && (
                              <>
                                <Button size="sm" onClick={() => setAction({ kind: 'APPROVE_TRANSFER', transfer: t })}><Check className="mr-1 h-4 w-4" />Approve</Button>
                                <Button size="sm" variant="outline" onClick={() => { setInput(''); setAction({ kind: 'DECLINE_TRANSFER', transfer: t }); }}><X className="mr-1 h-4 w-4" />Decline</Button>
                              </>
                            )}
                            {canUpdate && failed && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => setAction({ kind: 'RETRY_TRANSFER', transfer: t })}><RotateCcw className="mr-1 h-4 w-4" />Retry</Button>
                                <Button size="sm" variant="outline" onClick={() => { setInput(''); setAction({ kind: 'CONFIRM_TRANSFER', transfer: t }); }}><Check className="mr-1 h-4 w-4" />Paid</Button>
                                {t.purpose !== 'SHOP' && (
                                  <Button size="sm" variant="ghost" onClick={() => { setInput(''); setAction({ kind: 'RELEASE_TRANSFER', transfer: t }); }}><Undo2 className="mr-1 h-4 w-4" />Release</Button>
                                )}
                              </>
                            )}
                            {canUpdate && t.status === 'SENT_UNAPPLIED' && (
                              <Button size="sm" variant="outline" onClick={() => { setInput(''); setAction({ kind: 'RESOLVE_TRANSFER', transfer: t }); }}>Resolve</Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Account ledger</CardTitle>
          <CardDescription>Every movement of the account, newest first, with the balance after it.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!data?.entries.length ? (
            <EmptyState title={loading ? 'Loading…' : 'No movements yet'} hint={loading ? undefined : 'Record the first funding to start.'} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="text-right">Balance after</TableHead>
                    <TableHead>Bank ref</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-xs">{dateTime(e.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{e.reference}</TableCell>
                      <TableCell>{e.type.charAt(0) + e.type.slice(1).toLowerCase()}</TableCell>
                      <TableCell className="text-right text-emerald-700">{e.direction === 'CREDIT' ? money(e.amount) : ''}</TableCell>
                      <TableCell className="text-right text-red-600">{e.direction === 'DEBIT' ? money(e.amount) : ''}</TableCell>
                      <TableCell className="text-right font-medium">{money(e.balanceAfter)}</TableCell>
                      <TableCell className="font-mono text-xs">{e.bankReference ?? ''}</TableCell>
                      <TableCell className="max-w-[320px] text-xs text-muted-foreground">{e.description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {account && <SettingsDialog open={editing} onOpenChange={setEditing} account={account} onDone={() => void load()} />}
      <MovementDialog open={moving} onOpenChange={setMoving} onDone={() => void load()} />

      <Dialog open={!!action} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{actionText?.title}</DialogTitle>
            <DialogDescription>
              {actionText?.body}
              {action && 'transfer' in action && ` (${action.transfer.reference}, ${money(action.transfer.amount)} ETB to ${action.transfer.creditAccount})`}
            </DialogDescription>
          </DialogHeader>
          {actionText?.input && (
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={actionText.input === 'bankReference' ? 'FT number from the bank' : 'Reason'}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAction(null)} disabled={busy}>Back</Button>
            <Button onClick={() => void runAction()} disabled={busy || (!!actionText?.input && input.trim().length < (actionText.input === 'bankReference' ? 4 : 3))}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {actionText?.button}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
