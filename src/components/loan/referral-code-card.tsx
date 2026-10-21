'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Gift, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type ReferralStatus = { referred: boolean; affiliateName: string | null; canEnterCode: boolean };

/**
 * "Have a referral code?" box for the mini-app. Shows only while the customer
 * can still use a code (not referred yet and, for new-customer programs, no
 * loan or order yet).
 */
export function ReferralCodeCard({ className }: { className?: string }) {
  const [status, setStatus] = useState<ReferralStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedBy, setAppliedBy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/referral-code', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setStatus(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = async () => {
    if (!code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/referral-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'Could not apply the code. Please try again.');
        return;
      }
      setAppliedBy(data.affiliateName ?? '');
    } catch {
      setError('Could not apply the code. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (appliedBy !== null) {
    return (
      <div className={cn('flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800', className)}>
        <CheckCircle2 className="h-5 w-5 shrink-0" />
        <span>Referral code applied{appliedBy ? `. You were invited by ${appliedBy}.` : '.'}</span>
      </div>
    );
  }

  if (!status?.canEnterCode || dismissed) return null;

  return (
    <div className={cn('rounded-xl border bg-white p-3 shadow-sm sm:p-4', className)}>
      <div className="flex items-center gap-3">
        <Gift className="h-5 w-5 shrink-0 text-primary" />
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex-1 text-left text-sm font-medium">
          Have a referral code?
        </button>
        <button type="button" onClick={() => setDismissed(true)} className="text-muted-foreground hover:text-foreground" aria-label="Hide">
          <X className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void apply();
              }}
              placeholder="Enter code"
              maxLength={20}
              autoCapitalize="characters"
              className="font-mono uppercase"
            />
            <Button onClick={() => void apply()} disabled={submitting || !code.trim()}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
            </Button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <p className="text-xs text-muted-foreground">You can use only one referral code, and it can't be changed later.</p>
        </div>
      )}
    </div>
  );
}
