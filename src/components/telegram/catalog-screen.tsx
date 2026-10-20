'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Package, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEtb } from '@/lib/marketplace/order-status';
import { useTelegram } from './telegram-provider';
import { useBackButton } from './use-telegram-buttons';
import { TgTabs } from './tg-tabs';
import type { CatalogItem, CatalogResponse } from './types';

const SEARCH_DEBOUNCE_MS = 300;

export function CatalogScreen() {
  const { api } = useTelegram();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useBackButton(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (categoryId) params.set('categoryId', categoryId);
    api<CatalogResponse>(`/api/tg/catalog?${params.toString()}`)
      .then(result => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, debouncedSearch, categoryId]);

  return (
    <div>
      <TgTabs />
      <div className="space-y-3 px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 tg-hint" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search products or merchants"
            className="tg-input h-10 rounded-xl pl-9"
            inputMode="search"
          />
        </div>

        {data && data.categories.length > 0 && (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {[{ id: '', name: 'All' }, ...data.categories].map(category => (
              <button
                key={category.id || 'all'}
                type="button"
                data-active={categoryId === category.id}
                onClick={() => setCategoryId(category.id)}
                className="tg-chip shrink-0 rounded-full px-3 py-1.5 text-xs font-medium"
              >
                {category.name}
              </button>
            ))}
          </div>
        )}

        {error ? (
          <p className="py-10 text-center text-sm tg-destructive">{error}</p>
        ) : loading && !data ? (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-52 rounded-2xl" />
            ))}
          </div>
        ) : data && data.items.length === 0 ? (
          <p className="py-10 text-center text-sm tg-hint">No products match your search.</p>
        ) : (
          <div className={`grid grid-cols-2 gap-3 ${loading ? 'opacity-60' : ''}`}>
            {data?.items.map(item => <ItemCard key={item.id} item={item} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemCard({ item }: { item: CatalogItem }) {
  const hasDiscount = item.discountedPrice != null && item.discountedPrice < item.price;
  return (
    <Link href={`/tg/items/${item.id}`} className="tg-section block overflow-hidden">
      <div className="relative aspect-square bg-black/5">
        {item.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image} alt={item.name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Package className="h-8 w-8 tg-hint" />
          </div>
        )}
        {item.bestDiscount && hasDiscount && (
          <span className="absolute left-2 top-2 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
            {item.bestDiscount.type === 'PERCENTAGE' ? `-${item.bestDiscount.value}%` : 'SALE'}
          </span>
        )}
      </div>
      <div className="space-y-0.5 p-2.5">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{item.name}</p>
        <p className="truncate text-xs tg-hint">{item.merchant.name}</p>
        <div className="flex items-baseline gap-1.5 pt-0.5">
          <span className="text-sm font-semibold">{formatEtb(hasDiscount ? item.discountedPrice! : item.price)}</span>
          {hasDiscount && <span className="text-[11px] line-through tg-hint">{formatEtb(item.price)}</span>}
        </div>
        {!item.orderable && <p className="text-[11px] font-medium text-amber-600">Pay later · Nib app only</p>}
      </div>
    </Link>
  );
}
