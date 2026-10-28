'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { extractErrorMessage } from '@/lib/fetch-utils';
import { cn } from '@/lib/utils';

export type Option = { id: string; name: string };
export type AffiliateOptions = {
  providers: Option[];
  products: (Option & { providerId: string })[];
  merchants: Option[];
  categories: Option[];
  programs: (Option & { status: string })[];
  /** ETB per point, from the points settings. */
  pointValue: number;
};

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(await extractErrorMessage(res, 'Something went wrong. Please try again.'));
  return res.json() as Promise<T>;
}

export function useAffiliateOptions() {
  const [options, setOptions] = useState<AffiliateOptions>({
    providers: [],
    products: [],
    merchants: [],
    categories: [],
    programs: [],
    pointValue: 0.1,
  });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    apiRequest<AffiliateOptions>('/api/affiliates/options')
      .then(setOptions)
      .catch(() => undefined);
  }, [reloadKey]);
  return { options, reload: () => setReloadKey((k) => k + 1) };
}

export function lookupsFrom(options: AffiliateOptions) {
  const toMap = (rows: Option[]) => Object.fromEntries(rows.map((r) => [r.id, r.name]));
  return {
    providers: toMap(options.providers),
    products: toMap(options.products),
    merchants: toMap(options.merchants),
    categories: toMap(options.categories),
  };
}

const GOOD = ['ACTIVE', 'SUCCESS', 'PAID', 'COMPLETED', 'APPROVED', 'CREDITED'];
const WAITING = ['PENDING', 'PENDING_APPROVAL', 'DRAFT', 'PAYABLE', 'IN_PAYOUT', 'SENDING'];
const WARNING = ['PAUSED', 'SUSPENDED', 'PARTIAL'];
const BAD = ['REVERSED', 'REJECTED', 'FAILED'];

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'On hold',
  PAYABLE: 'Ready to pay',
  IN_PAYOUT: 'In a payout',
  PENDING_APPROVAL: 'Waiting for approval',
  CREDITED: 'Added as points',
};

export function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
}

export function StatusBadge({ status }: { status: string }) {
  const tone = GOOD.includes(status)
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : WAITING.includes(status)
      ? 'border-sky-200 bg-sky-50 text-sky-700'
      : WARNING.includes(status)
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : BAD.includes(status)
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-muted bg-muted text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap font-medium', tone)}>
      {statusLabel(status)}
    </Badge>
  );
}

export function money(value: number | null | undefined) {
  const n = Number(value ?? 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function shortDate(value: string | Date | null | undefined) {
  if (!value) return '—';
  return format(new Date(value), 'dd MMM yyyy');
}

export function dateTime(value: string | Date | null | undefined) {
  if (!value) return '—';
  return format(new Date(value), 'dd MMM yyyy, HH:mm');
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground">
      <Inbox className="h-8 w-8" />
      <div className="font-medium text-foreground">{title}</div>
      {hint && <div className="max-w-md text-sm">{hint}</div>}
    </div>
  );
}

/** Searchable checkbox list in a popover. An empty selection means "all". */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  options: Option[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = new Set(value);
  const filtered = options.filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()));
  const names = options.filter((o) => selected.has(o.id)).map((o) => o.name);
  const label = names.length === 0 ? placeholder : names.length <= 2 ? names.join(', ') : `${names.length} selected`;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn('w-full justify-between font-normal', names.length === 0 && 'text-muted-foreground')}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        {options.length > 6 && (
          <Input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-2 h-8"
          />
        )}
        <div className="max-h-60 space-y-1 overflow-y-auto">
          {filtered.length === 0 && <div className="px-2 py-4 text-center text-sm text-muted-foreground">Nothing found</div>}
          {filtered.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <Checkbox checked={selected.has(o.id)} onCheckedChange={() => toggle(o.id)} />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
        {value.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" onClick={() => onChange([])}>
            Clear selection
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Number input that maps an empty field to null. */
export function NumberInput({
  value,
  onChange,
  placeholder,
  min = 0,
  step = 'any',
  className,
  disabled,
  id,
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  placeholder?: string;
  min?: number;
  step?: number | 'any';
  className?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(null);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : null);
      }}
    />
  );
}

export function useAffiliatePermissions(currentUser: any) {
  const perms = currentUser?.permissions?.affiliates ?? {};
  // Customers' withdrawals above the automatic limit are reviewed by checkers.
  const canReview = !!currentUser?.permissions?.approvals?.update;
  return { canCreate: !!perms.create, canUpdate: !!perms.update, canReview };
}
