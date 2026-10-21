'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Gift } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * "Earn" link for the mini-app headers. Hidden unless the person is an
 * affiliate, has rewards, or can get their own code; a dot shows when money is
 * available.
 */
export function EarnLink({ className, dotClassName }: { className?: string; dotClassName?: string }) {
  const [entry, setEntry] = useState<{ visible: boolean; available: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/earn?entry=1', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setEntry(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entry?.visible) return null;

  return (
    <Link href="/earn" className={cn('relative inline-flex items-center gap-1.5', className)}>
      <Gift className="h-4 w-4" />
      Earn
      {entry.available > 0 && (
        <span
          className={cn('absolute -right-2 -top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white', dotClassName)}
          aria-label="Earnings available"
        />
      )}
    </Link>
  );
}
