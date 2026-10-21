'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Copy, Loader2, Pencil, Plus, RefreshCw, Search, ShieldOff, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useToast } from '@/hooks/use-toast';
import { AFFILIATE_TYPES, AFFILIATE_TYPE_LABELS, type AffiliateType, type ProgramConfig } from '@/lib/affiliate/config';
import { EmptyState, StatusBadge, apiRequest, money, shortDate } from './shared';

type AffiliateRow = {
  id: string;
  code: string;
  type: AffiliateType;
  name: string;
  phoneNumber: string;
  email: string | null;
  payoutAccount: string | null;
  status: string;
  /** ADMIN, or SELF for customers who got their own code in the mini-app. */
  source: string;
  suspendedReason: string | null;
  program: { id: string; name: string };
  createdAt: string;
  referralCount: number;
  earned: number;
  unpaid: number;
  paid: number;
  pendingChange: boolean;
};

type AffiliatesResponse = {
  affiliates: AffiliateRow[];
  pendingCreates: { id: string; name: string | null; createdAt: string }[];
};

type ProgramChoice = { id: string; name: string; status: string; config: ProgramConfig | null };

function AffiliateFormDialog({
  open,
  onOpenChange,
  affiliate,
  programs,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  affiliate: AffiliateRow | null;
  programs: ProgramChoice[];
  onSubmitted: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: '', phoneNumber: '', programId: '', type: '' as AffiliateType | '', code: '', email: '', payoutAccount: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(
      affiliate
        ? {
            name: affiliate.name,
            phoneNumber: affiliate.phoneNumber,
            programId: affiliate.program.id,
            type: affiliate.type,
            code: affiliate.code,
            email: affiliate.email ?? '',
            payoutAccount: affiliate.payoutAccount ?? '',
          }
        : { name: '', phoneNumber: '', programId: programs[0]?.id ?? '', type: '', code: '', email: '', payoutAccount: '' }
    );
  }, [open, affiliate, programs]);

  const program = programs.find((p) => p.id === form.programId);
  const allowedTypes = useMemo(
    () => (program?.config ? AFFILIATE_TYPES.filter((t) => program.config!.allowedAffiliateTypes.includes(t)) : [...AFFILIATE_TYPES]),
    [program]
  );
  useEffect(() => {
    if (form.type && !allowedTypes.includes(form.type)) setForm((f) => ({ ...f, type: '' }));
    if (!form.type && allowedTypes.length === 1) setForm((f) => ({ ...f, type: allowedTypes[0] }));
  }, [allowedTypes, form.type]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const needsAccount = form.type !== 'BORROWER';

  const submit = async () => {
    setSaving(true);
    try {
      if (affiliate) {
        const changes: Record<string, string> = {};
        if (form.name.trim() !== affiliate.name) changes.name = form.name.trim();
        if (form.type && form.type !== affiliate.type) changes.type = form.type;
        if (form.programId !== affiliate.program.id) changes.programId = form.programId;
        if (form.email.trim() !== (affiliate.email ?? '')) changes.email = form.email.trim();
        if (form.payoutAccount.trim() !== (affiliate.payoutAccount ?? '')) changes.payoutAccount = form.payoutAccount.trim();
        await apiRequest('/api/affiliates', { method: 'PUT', body: JSON.stringify({ affiliateId: affiliate.id, ...changes }) });
      } else {
        await apiRequest('/api/affiliates', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name,
            phoneNumber: form.phoneNumber,
            programId: form.programId,
            type: form.type,
            code: form.code.trim() || null,
            email: form.email.trim(),
            payoutAccount: form.payoutAccount.trim(),
          }),
        });
      }
      toast({ title: 'Sent for approval', description: 'A checker must approve it on the Approvals page.' });
      onOpenChange(false);
      onSubmitted();
    } catch (error: any) {
      toast({ title: 'Could not submit', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const incomplete = !form.name.trim() || !form.phoneNumber.trim() || !form.programId || !form.type || (needsAccount && !form.payoutAccount.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{affiliate ? `Edit ${affiliate.name}` : 'Add affiliate'}</DialogTitle>
          <DialogDescription>
            {affiliate
              ? 'Changes (including the payout account) take effect after approval.'
              : 'The affiliate gets a referral code once a checker approves the request.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>Full name</Label>
            <Input value={form.name} onChange={set('name')} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Phone number</Label>
              <Input value={form.phoneNumber} onChange={set('phoneNumber')} placeholder="09XXXXXXXX" disabled={!!affiliate} />
            </div>
            <div className="space-y-1.5">
              <Label>Email (optional)</Label>
              <Input value={form.email} onChange={set('email')} type="email" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Program</Label>
              <Select value={form.programId} onValueChange={(programId) => setForm((f) => ({ ...f, programId }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a program" />
                </SelectTrigger>
                <SelectContent>
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.status !== 'ACTIVE' ? ' (paused)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(type) => setForm((f) => ({ ...f, type: type as AffiliateType }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {allowedTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {AFFILIATE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Payout account {needsAccount ? '' : '(optional)'}</Label>
            <Input value={form.payoutAccount} onChange={set('payoutAccount')} placeholder="CBS account number" />
            <p className="text-xs text-muted-foreground">
              {needsAccount
                ? 'Commissions are paid into this account.'
                : 'Leave empty to pay into the active account linked to their phone number.'}
            </p>
          </div>
          {!affiliate && (
            <div className="space-y-1.5">
              <Label>Referral code (optional)</Label>
              <Input value={form.code} onChange={set('code')} placeholder="Generated automatically" className="uppercase" />
              <p className="text-xs text-muted-foreground">4 to 16 letters or digits, e.g. ABEBE10.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || incomplete}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AffiliatesTab({ canCreate, canUpdate }: { canCreate: boolean; canUpdate: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<AffiliatesResponse | null>(null);
  const [programs, setPrograms] = useState<ProgramChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [programFilter, setProgramFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AffiliateRow | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ affiliate: AffiliateRow; action: 'SUSPEND' | 'REACTIVATE' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (programFilter !== 'all') params.set('programId', programFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const [affiliates, programList] = await Promise.all([
        apiRequest<AffiliatesResponse>(`/api/affiliates?${params}`),
        apiRequest<{ programs: ProgramChoice[] }>('/api/affiliates/programs'),
      ]);
      setData(affiliates);
      setPrograms(programList.programs);
    } catch (error: any) {
      toast({ title: 'Could not load affiliates', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [search, programFilter, statusFilter, toast]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast({ title: 'Code copied', description: code });
    } catch {
      toast({ title: code, description: 'Copy the code manually.' });
    }
  };

  const runStatusChange = async () => {
    if (!statusTarget) return;
    setBusy(true);
    try {
      await apiRequest('/api/affiliates/status', {
        method: 'POST',
        body: JSON.stringify({ affiliateId: statusTarget.affiliate.id, action: statusTarget.action, reason: reason.trim() || undefined }),
      });
      toast(
        statusTarget.action === 'SUSPEND'
          ? { title: 'Affiliate suspended', description: 'No new commissions; their payouts are on hold.' }
          : { title: 'Sent for approval', description: 'The affiliate is reactivated once a checker approves it.' }
      );
      setStatusTarget(null);
      setReason('');
      await load();
    } catch (error: any) {
      toast({ title: 'Action failed', description: error.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search name, phone or code" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={programFilter} onValueChange={setProgramFilter}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All programs</SelectItem>
            {programs.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="SUSPENDED">Suspended</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        {canCreate && (
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            disabled={!programs.length}
            title={!programs.length ? 'Create a program first' : undefined}
          >
            <Plus className="mr-2 h-4 w-4" /> Add affiliate
          </Button>
        )}
      </div>

      {data?.pendingCreates.length ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
          <div className="flex items-center gap-2 font-medium">
            <Clock className="h-4 w-4" /> Waiting for approval
          </div>
          <ul className="mt-1 list-disc pl-6">
            {data.pendingCreates.map((p) => (
              <li key={p.id}>
                {p.name ?? 'New affiliate'} (submitted {shortDate(p.createdAt)})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {!data?.affiliates.length ? (
            <EmptyState
              title={loading ? 'Loading…' : 'No affiliates found'}
              hint={loading ? undefined : 'Add an affiliate to a program. They get a code to share once the request is approved.'}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Affiliate</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Program</TableHead>
                    <TableHead>Payout account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Referrals</TableHead>
                    <TableHead className="text-right">Earned</TableHead>
                    <TableHead className="text-right">Not yet paid</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    {canUpdate && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.affiliates.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {AFFILIATE_TYPE_LABELS[a.type] ?? a.type} · {a.phoneNumber}
                          {a.source === 'SELF' && ' · joined in the mini-app'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => void copyCode(a.code)}
                          className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-sm hover:bg-muted/70"
                          title="Copy code"
                        >
                          {a.code} <Copy className="h-3 w-3" />
                        </button>
                      </TableCell>
                      <TableCell>{a.program.name}</TableCell>
                      <TableCell className="font-mono text-xs">{a.payoutAccount ?? 'Linked account'}</TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge status={a.status} />
                          {a.pendingChange && <StatusBadge status="PENDING_APPROVAL" />}
                          {a.status === 'SUSPENDED' && a.suspendedReason && (
                            <span className="max-w-[200px] text-xs text-muted-foreground">{a.suspendedReason}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{a.referralCount}</TableCell>
                      <TableCell className="text-right">{money(a.earned)}</TableCell>
                      <TableCell className="text-right">{money(a.unpaid)}</TableCell>
                      <TableCell className="text-right">{money(a.paid)}</TableCell>
                      {canUpdate && (
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              disabled={a.pendingChange}
                              onClick={() => {
                                setEditing(a);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {a.status === 'ACTIVE' ? (
                              <Button variant="ghost" size="icon" title="Suspend" onClick={() => setStatusTarget({ affiliate: a, action: 'SUSPEND' })}>
                                <ShieldOff className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Reactivate"
                                disabled={a.pendingChange}
                                onClick={() => setStatusTarget({ affiliate: a, action: 'REACTIVATE' })}
                              >
                                <ShieldCheck className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AffiliateFormDialog open={formOpen} onOpenChange={setFormOpen} affiliate={editing} programs={programs} onSubmitted={() => void load()} />

      <Dialog open={!!statusTarget} onOpenChange={(open) => !open && setStatusTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {statusTarget?.action === 'SUSPEND' ? `Suspend ${statusTarget?.affiliate.name}?` : `Reactivate ${statusTarget?.affiliate.name}?`}
            </DialogTitle>
            <DialogDescription>
              {statusTarget?.action === 'SUSPEND'
                ? 'Takes effect now: their code stops working, no new commissions are recorded and their payouts are held. Reactivating catches up on what they earned meanwhile.'
                : 'Reactivation releases held payouts, so it needs approval.'}
            </DialogDescription>
          </DialogHeader>
          {statusTarget?.action === 'SUSPEND' && (
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="e.g. Several referred customers look like the same person" />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={statusTarget?.action === 'SUSPEND' ? 'destructive' : 'default'}
              onClick={() => void runStatusChange()}
              disabled={busy || (statusTarget?.action === 'SUSPEND' && !reason.trim())}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {statusTarget?.action === 'SUSPEND' ? 'Suspend now' : 'Request reactivation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
