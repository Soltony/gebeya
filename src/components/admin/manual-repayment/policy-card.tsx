'use client';

import { useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { ALLOCATION_BUCKETS, BUCKET_LABELS } from '@/lib/manual-repayment';
import type { Policy } from './types';

/**
 * Bank-policy settings for the module. Read-only unless the signed-in user is a
 * System Admin.
 *
 * The allocation order and the overpayment rule are not settings: both belong to
 * the shared posting engine every repayment channel uses, so they are shown here
 * as facts rather than offered as choices.
 */
export function PolicyCard({
  policy,
  canEdit,
  onSaved,
}: {
  policy: Policy;
  canEdit: boolean;
  onSaved: (policy: Policy) => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Policy>(policy);
  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    setIsSaving(true);
    try {
      const res = await fetch('/api/manual-repayments/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          makerApprovalLimit: draft.makerApprovalLimit,
          requireAttachment: draft.requireAttachment,
          notifyCustomer: draft.notifyCustomer,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'The policy could not be saved.');
      toast({ title: 'Saved', description: 'The manual repayment policy was updated.' });
      onSaved(data.policy as Policy);
    } catch (e) {
      toast({
        title: 'Error',
        description: String((e as Error)?.message ?? e),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repayment policy</CardTitle>
        <CardDescription>
          How manual repayments are validated.{' '}
          {canEdit
            ? 'Only a System Admin can change these.'
            : 'Shown read-only — ask a System Admin to change them.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="limit">Maker approval limit (ETB)</Label>
            <Input
              id="limit"
              type="number"
              min="0"
              step="0.01"
              disabled={!canEdit}
              value={draft.makerApprovalLimit ?? ''}
              placeholder="No limit"
              onChange={(e) =>
                setDraft({
                  ...draft,
                  makerApprovalLimit: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Repayments above this amount are refused at entry. Leave empty for no ceiling.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="attachment-required">Require a receipt</Label>
              <p className="text-xs text-muted-foreground">
                Every entry must carry a slip or receipt.
              </p>
            </div>
            <Switch
              id="attachment-required"
              checked={draft.requireAttachment}
              disabled={!canEdit}
              onCheckedChange={(v) => setDraft({ ...draft, requireAttachment: v })}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="notify">Notify the customer</Label>
              <p className="text-xs text-muted-foreground">
                SMS the customer once a repayment is posted.
              </p>
            </div>
            <Switch
              id="notify"
              checked={draft.notifyCustomer}
              disabled={!canEdit}
              onCheckedChange={(v) => setDraft({ ...draft, notifyCustomer: v })}
            />
          </div>
        </div>

        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Info className="h-4 w-4" />
            Fixed by the posting engine
          </p>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Allocation order
            </p>
            <p className="mt-1 text-sm">
              {ALLOCATION_BUCKETS.map((b) => BUCKET_LABELS[b]).join(' → ')}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Overpayment
            </p>
            <p className="mt-1 text-sm">
              Refused. An amount above what is due is never partially posted, so the maker is shown
              the payable figure before recording.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Manual repayments share the same pipeline as the gateway callback and the
            pending-payment resolution, so these rules are identical across every channel.
          </p>
        </div>
      </CardContent>

      {canEdit && (
        <CardFooter className="justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(policy)} disabled={isSaving}>
            Reset
          </Button>
          <Button onClick={save} disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save policy
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
