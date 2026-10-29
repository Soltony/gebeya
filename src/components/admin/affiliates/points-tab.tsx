'use client';

import { useCallback, useEffect, useState } from 'react';
import { Coins, Loader2, Pencil, PlusCircle, RefreshCw, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { formatMoney, formatPoints } from '@/lib/affiliate/config';
import { cn } from '@/lib/utils';
import { EmptyState, NumberInput, apiRequest, dateTime } from './shared';

type PointRow = {
  id: string;
  reference: string;
  createdAt: string;
  phone: string;
  affiliate: { name: string; code: string } | null;
  type: 'EARN' | 'REVERSAL' | 'ADJUST' | 'REDEEM' | 'REFUND';
  points: number;
  birrValue: number;
  note: string | null;
};

type PointsResponse = {
  settings: SettingsForm & { version: number; publishedAt: string | null; summary: string };
  settingsPending: boolean;
  pendingAdjustments: { id: string; name: string | null; createdAt: string }[];
  summary: {
    outstanding: number;
    outstandingValue: number;
    earnedThisMonth: number;
    takenBackThisMonth: number;
    adjustedThisMonth: number;
    usedThisMonth: number;
  };
  wallet: { phone: string; balance: number; name: string | null } | null;
  transactions: PointRow[];
};

const TYPE_LABELS: Record<PointRow['type'], string> = {
  EARN: 'Earned',
  REVERSAL: 'Taken back',
  ADJUST: 'Adjusted',
  REDEEM: 'Used',
  REFUND: 'Returned',
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function AdjustDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const { toast } = useToast();
  const [phone, setPhone] = useState('');
  const [direction, setDirection] = useState<'ADD' | 'REMOVE'>('ADD');
  const [points, setPoints] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPhone('');
      setDirection('ADD');
      setPoints(null);
      setReason('');
    }
  }, [open]);

  const valid = phone.trim().length >= 9 && !!points && points > 0 && Number.isInteger(points) && reason.trim().length >= 3;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await apiRequest('/api/affiliates/points', {
        method: 'POST',
        body: JSON.stringify({ action: 'ADJUST', phone, points: direction === 'ADD' ? points : -points!, reason }),
      });
      toast({ title: 'Sent for approval', description: 'A checker must approve it on the Approvals page.' });
      onOpenChange(false);
      onDone();
    } catch (error: any) {
      toast({ title: 'Could not submit', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust points</DialogTitle>
          <DialogDescription>
            Add or remove points for one person, for example to correct a mistake. A checker approves it before it takes effect.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Phone number</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0911223344" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Action</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as 'ADD' | 'REMOVE')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADD">Add points</SelectItem>
                  <SelectItem value="REMOVE">Remove points</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Points</Label>
              <NumberInput min={1} step={1} value={points} onChange={setPoints} placeholder="e.g. 500" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Reason</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Shown to the checker and kept in the history" />
          </div>
          <p className="text-xs text-muted-foreground">Points can&apos;t be removed below a balance of zero.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type UseSettings = {
  enabled: boolean;
  birrPerPoint: number | null;
  minPoints: number;
  maxPointsPerDay: number | null;
  maxPointsPerMonth: number | null;
};
type SettingsForm = {
  pointValue: number;
  shop: UseSettings;
  repayment: UseSettings;
  withdrawal: UseSettings & { autoApproveUpTo: number };
};

const USES: Array<{ key: 'shop' | 'repayment' | 'withdrawal'; label: string; hint: string }> = [
  { key: 'shop', label: 'Shop', hint: 'Pay a whole shop order; the merchant is paid when the customer confirms delivery.' },
  { key: 'repayment', label: 'Loan repayment', hint: 'Pay what a loan needs now; the provider’s repayment account is paid.' },
  { key: 'withdrawal', label: 'Withdrawal', hint: 'Cash to the customer’s own account.' },
];

function SettingsDialog({
  open,
  onOpenChange,
  current,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: SettingsForm;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<SettingsForm>(current);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(JSON.parse(JSON.stringify(current)));
    // Only when the dialog opens: `current` is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setUse = (key: 'shop' | 'repayment' | 'withdrawal', patch: Partial<SettingsForm['withdrawal']>) =>
    setForm((f) => ({ ...f, [key]: { ...f[key], ...patch } }));
  const changed = JSON.stringify(form) !== JSON.stringify(current);
  const valid = form.pointValue > 0 && USES.every((u) => form[u.key].minPoints >= 1);

  const submit = async () => {
    setSaving(true);
    try {
      await apiRequest('/api/affiliates/points', {
        method: 'POST',
        body: JSON.stringify({ action: 'UPDATE_SETTINGS', settings: form }),
      });
      toast({ title: 'Sent for approval', description: 'A checker must approve it on the Approvals page.' });
      onOpenChange(false);
      onDone();
    } catch (error: any) {
      toast({ title: 'Could not submit', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Points settings</DialogTitle>
          <DialogDescription>
            One set of settings for every program, so a point is worth the same whichever program gave it. Every use is paid from the
            Affiliate Program account. Changes apply after a checker approves them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label>Value of 1 point (ETB)</Label>
          <NumberInput step="any" value={form.pointValue} onChange={(v) => setForm((f) => ({ ...f, pointValue: v ?? 0 }))} />
          <p className="text-xs text-muted-foreground">
            Shown next to balances and used in reports, and what a point buys when a use has no rate of its own.
            {form.pointValue > 0 ? ` ${Math.round((1 / form.pointValue) * 100) / 100} points = 1 ETB.` : ''}
          </p>
        </div>
        {USES.map((u) => {
          const s = form[u.key];
          return (
            <div key={u.key} className="space-y-3 rounded-md border p-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{u.label}</div>
                  <div className="text-xs text-muted-foreground">{u.hint}</div>
                </div>
                <Switch checked={s.enabled} onCheckedChange={(enabled) => setUse(u.key, { enabled })} />
              </div>
              {s.enabled && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-1">
                    <Label className="text-xs">ETB per point</Label>
                    <NumberInput step="any" placeholder={`${form.pointValue} (point value)`} value={s.birrPerPoint} onChange={(birrPerPoint) => setUse(u.key, { birrPerPoint })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Minimum points</Label>
                    <NumberInput min={1} step={1} value={s.minPoints} onChange={(v) => setUse(u.key, { minPoints: v ?? 1 })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max points a day</Label>
                    <NumberInput min={1} step={1} placeholder="No limit" value={s.maxPointsPerDay} onChange={(maxPointsPerDay) => setUse(u.key, { maxPointsPerDay })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Max points a month</Label>
                    <NumberInput min={1} step={1} placeholder="No limit" value={s.maxPointsPerMonth} onChange={(maxPointsPerMonth) => setUse(u.key, { maxPointsPerMonth })} />
                  </div>
                  {u.key === 'withdrawal' && (
                    <div className="space-y-1 sm:col-span-2">
                      <Label className="text-xs">Send automatically up to (ETB)</Label>
                      <NumberInput value={form.withdrawal.autoApproveUpTo} onChange={(v) => setUse('withdrawal', { autoApproveUpTo: v ?? 0 })} />
                      <p className="text-xs text-muted-foreground">Larger withdrawals wait for a checker in Affiliates → Account. 0 = a checker approves every withdrawal.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || !changed || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PointsTab({ canUpdate }: { canUpdate: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<PointsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('ALL');
  const [adjusting, setAdjusting] = useState(false);
  const [editingSettings, setEditingSettings] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('search', query);
      if (type !== 'ALL') params.set('type', type);
      setData(await apiRequest<PointsResponse>(`/api/affiliates/points?${params.toString()}`));
    } catch (error: any) {
      toast({ title: 'Could not load points', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [query, type, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const s = data?.summary;
  const value = data?.settings.pointValue ?? 0;

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Programs that pay rewards as points add them to each person&apos;s points wallet when the hold ends; take-backs remove them.
        Every change is kept here with a reference. Points are used to shop, repay loans or withdraw as set below; each use is paid from the Affiliate Program account (Affiliates → Account).
      </p>

      {s && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Points outstanding" value={formatPoints(s.outstanding)} hint={`≈ ${formatMoney(s.outstandingValue)}`} />
          <Stat label="Earned this month" value={formatPoints(s.earnedThisMonth)} />
          <Stat label="Taken back this month" value={formatPoints(s.takenBackThisMonth)} />
          <Stat label="Adjusted this month" value={formatPoints(s.adjustedThisMonth)} />
          <Stat label="Used this month" value={formatPoints(s.usedThisMonth)} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Coins className="h-4 w-4" /> Points settings
            </CardTitle>
            <CardDescription>{data ? data.settings.summary : 'Loading…'}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              {data?.settings.version
                ? `Version ${data.settings.version}${data.settings.publishedAt ? `, approved ${dateTime(data.settings.publishedAt)}` : ''}`
                : 'Default settings (never changed)'}
              {data?.settingsPending && <Badge className="ml-2 border-sky-200 bg-sky-50 text-sky-700" variant="outline">Change waiting for approval</Badge>}
            </span>
            {canUpdate && (
              <Button size="sm" variant="outline" onClick={() => setEditingSettings(true)} disabled={!data || data.settingsPending}>
                <Pencil className="mr-2 h-4 w-4" /> Change
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Adjustments</CardTitle>
            <CardDescription>Add or remove points by hand, with a checker&apos;s approval.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {canUpdate && (
              <Button size="sm" onClick={() => setAdjusting(true)}>
                <PlusCircle className="mr-2 h-4 w-4" /> Adjust points
              </Button>
            )}
            {data?.pendingAdjustments.length ? (
              <ul className="space-y-1">
                {data.pendingAdjustments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                    <span>{p.name ?? 'Points adjustment'}</span>
                    <span className="text-xs text-sky-700">Waiting for approval · {dateTime(p.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No adjustments waiting for approval.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setQuery(search.trim());
            }}
            placeholder="Phone, affiliate code or PTS- reference"
            className="w-72 pl-9"
          />
        </div>
        <Button variant="outline" onClick={() => setQuery(search.trim())}>
          Search
        </Button>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All changes</SelectItem>
            <SelectItem value="EARN">Earned</SelectItem>
            <SelectItem value="REVERSAL">Taken back</SelectItem>
            <SelectItem value="ADJUST">Adjusted</SelectItem>
            <SelectItem value="REDEEM">Used</SelectItem>
            <SelectItem value="REFUND">Returned</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {data?.wallet && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Balance for {data.wallet.name ? `${data.wallet.name} · ` : ''}
          {data.wallet.phone}: <strong>{formatPoints(data.wallet.balance)}</strong> (≈ {formatMoney(data.wallet.balance * value)})
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {!data?.transactions.length ? (
            <EmptyState
              title={loading ? 'Loading…' : query ? 'Nothing found' : 'No points yet'}
              hint={loading ? undefined : 'Points appear here when a points program credits a reward or an adjustment is approved.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Person</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                    <TableHead className="text-right">Value (ETB)</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.transactions.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="whitespace-nowrap text-xs">{dateTime(t.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{t.reference}</TableCell>
                      <TableCell>
                        <div className="font-medium">{t.affiliate ? `${t.affiliate.name} (${t.affiliate.code})` : 'Customer'}</div>
                        <div className="text-xs text-muted-foreground">{t.phone}</div>
                      </TableCell>
                      <TableCell>{TYPE_LABELS[t.type] ?? t.type}</TableCell>
                      <TableCell className={cn('text-right font-medium', t.points < 0 && 'text-red-600')}>
                        {t.points > 0 ? '+' : ''}
                        {t.points.toLocaleString('en-US')}
                      </TableCell>
                      <TableCell className="text-right text-xs">{t.birrValue.toLocaleString('en-US', { maximumFractionDigits: 2 })}</TableCell>
                      <TableCell className="max-w-[260px] text-xs text-muted-foreground">{t.note ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AdjustDialog open={adjusting} onOpenChange={setAdjusting} onDone={() => void load()} />
      {data && (
        <SettingsDialog
          open={editingSettings}
          onOpenChange={setEditingSettings}
          current={{ pointValue: data.settings.pointValue, shop: data.settings.shop, repayment: data.settings.repayment, withdrawal: data.settings.withdrawal }}
          onDone={() => void load()}
        />
      )}
    </div>
  );
}
