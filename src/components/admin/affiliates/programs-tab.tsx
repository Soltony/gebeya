'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock, Loader2, Pause, Pencil, Play, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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
import { useToast } from '@/hooks/use-toast';
import type { ProgramConfig } from '@/lib/affiliate/config';
import { ProgramBuilderDialog, type EditableProgram } from './program-builder';
import { EmptyState, StatusBadge, apiRequest, money, shortDate, type AffiliateOptions } from './shared';

type ProgramRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  currentVersion: number;
  pausedAt: string | null;
  createdAt: string;
  config: ProgramConfig | null;
  summary: string[];
  affiliateCount: number;
  referralCount: number;
  earnedTotal: number;
  pendingChange: boolean;
};

type ProgramsResponse = {
  programs: ProgramRow[];
  pendingCreates: { id: string; name: string | null; createdAt: string }[];
};

export function ProgramsTab({
  options,
  canCreate,
  canUpdate,
  onChanged,
}: {
  options: AffiliateOptions;
  canCreate: boolean;
  canUpdate: boolean;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [data, setData] = useState<ProgramsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<EditableProgram | null>(null);
  const [confirm, setConfirm] = useState<{ program: ProgramRow; action: 'PAUSE' | 'RESUME' } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiRequest<ProgramsResponse>('/api/affiliates/programs'));
    } catch (error: any) {
      toast({ title: 'Could not load programs', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setEditing(null);
    setBuilderOpen(true);
  };

  const openEdit = (program: ProgramRow) => {
    if (!program.config) return;
    setEditing({ id: program.id, name: program.name, description: program.description, config: program.config });
    setBuilderOpen(true);
  };

  const runStatusChange = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await apiRequest('/api/affiliates/programs/status', {
        method: 'POST',
        body: JSON.stringify({ programId: confirm.program.id, action: confirm.action }),
      });
      toast(
        confirm.action === 'PAUSE'
          ? { title: 'Program paused', description: 'No new referrals or commissions until it is resumed.' }
          : { title: 'Sent for approval', description: 'The program resumes once a checker approves it.' }
      );
      setConfirm(null);
      await load();
      onChanged();
    } catch (error: any) {
      toast({ title: 'Action failed', description: error.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          A program holds who can join, how referrals work, the commission rules, caps and payout settings.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
          {canCreate && (
            <Button size="sm" onClick={openNew}>
              <Plus className="mr-2 h-4 w-4" /> New program
            </Button>
          )}
        </div>
      </div>

      {data?.pendingCreates.length ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800">
          <div className="flex items-center gap-2 font-medium">
            <Clock className="h-4 w-4" /> Waiting for approval
          </div>
          <ul className="mt-1 list-disc pl-6">
            {data.pendingCreates.map((p) => (
              <li key={p.id}>
                {p.name ?? 'New program'} (submitted {shortDate(p.createdAt)})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : !data?.programs.length ? (
        <Card>
          <CardContent>
            <EmptyState
              title="No programs yet"
              hint="Create your first program from a template: Agent Network, Refer a Friend or Shop Promoters."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.programs.map((program) => (
            <Card key={program.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-lg">{program.name}</CardTitle>
                    <CardDescription>
                      Version {program.currentVersion} · since {shortDate(program.createdAt)}
                      {program.description ? ` · ${program.description}` : ''}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {program.pendingChange && <StatusBadge status="PENDING_APPROVAL" />}
                    <StatusBadge status={program.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-md bg-muted/50 p-2">
                    <div className="text-lg font-semibold">{program.affiliateCount}</div>
                    <div className="text-xs text-muted-foreground">Affiliates</div>
                  </div>
                  <div className="rounded-md bg-muted/50 p-2">
                    <div className="text-lg font-semibold">{program.referralCount}</div>
                    <div className="text-xs text-muted-foreground">Referred customers</div>
                  </div>
                  <div className="rounded-md bg-muted/50 p-2">
                    <div className="text-lg font-semibold">{money(program.earnedTotal)}</div>
                    <div className="text-xs text-muted-foreground">Earned (ETB)</div>
                  </div>
                </div>
                <ul className="space-y-1.5 text-sm">
                  {program.summary.map((line, i) => (
                    <li key={i} className="leading-snug">
                      {line}
                    </li>
                  ))}
                </ul>
                {canUpdate && (
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(program)}
                      disabled={program.pendingChange || !program.config}
                      title={program.pendingChange ? 'A change is already waiting for approval' : undefined}
                    >
                      <Pencil className="mr-2 h-4 w-4" /> Edit
                    </Button>
                    {program.status === 'ACTIVE' ? (
                      <Button variant="outline" size="sm" onClick={() => setConfirm({ program, action: 'PAUSE' })}>
                        <Pause className="mr-2 h-4 w-4" /> Pause
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirm({ program, action: 'RESUME' })}
                        disabled={program.pendingChange}
                      >
                        <Play className="mr-2 h-4 w-4" /> Resume
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ProgramBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        program={editing}
        options={options}
        onSubmitted={() => {
          void load();
          onChanged();
        }}
      />

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === 'PAUSE' ? `Pause “${confirm?.program.name}”?` : `Resume “${confirm?.program.name}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.action === 'PAUSE'
                ? 'Takes effect now. No new referrals are accepted and loans or orders that happen while paused never earn a commission, even after resuming. Commissions already earned are still paid.'
                : 'Resuming starts spending again, so it needs approval. Events that happened while the program was paused will not earn.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runStatusChange();
              }}
              disabled={busy}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {confirm?.action === 'PAUSE' ? 'Pause now' : 'Request resume'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
