'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, ShoppingCart, PlayCircle, Package, Tag, X, ChevronRight, Store, CreditCard } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';

const MAX_VISIBLE_MERCHANTS = 8;
const NEW_ITEM_DAYS = 7;
const MERCHANT_RESPONDED_STATUSES = ['PENDING_DELIVERY', 'ON_DELIVERY', 'CANCELLED'];

const getSeenOrderResponsesKey = (borrowerId: string) => `bnpl_seen_order_responses:${borrowerId}`;

export function ShopBrowse({ hasActiveLoan = false }: { hasActiveLoan?: boolean } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const borrowerId = searchParams?.get('borrowerId') || '';

  const [items, setItems] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [merchants, setMerchants] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [merchantSearch, setMerchantSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [merchantId, setMerchantId] = useState(searchParams?.get('merchantId') || '');
  const [searchOpen, setSearchOpen] = useState(false);
  const [merchantSearchOpen, setMerchantSearchOpen] = useState(false);
  const [showAllMerchants, setShowAllMerchants] = useState(false);
  const [orderCount, setOrderCount] = useState(0);
  const [merchantScrollIndex, setMerchantScrollIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const merchantSearchInputRef = useRef<HTMLInputElement>(null);

  const handleMerchantScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const max = scrollWidth - clientWidth;
    if (max <= 0) { setMerchantScrollIndex(0); return; }
    const pct = scrollLeft / max;
    if (pct < 0.33) setMerchantScrollIndex(0);
    else if (pct < 0.66) setMerchantScrollIndex(1);
    else setMerchantScrollIndex(2);
  };

  useEffect(() => {
    if (!borrowerId) return;
    fetch(`/api/bnpl/orders?borrowerId=${borrowerId}`)
      .then((r) => r.json())
      .then((orders) => {
        if (Array.isArray(orders)) {
          const seenRaw = window.localStorage.getItem(getSeenOrderResponsesKey(borrowerId));
          const seen = new Set<string>(seenRaw ? JSON.parse(seenRaw) : []);
          const unseenCount = orders.filter((o: any) => {
            if (!MERCHANT_RESPONDED_STATUSES.includes(o.status)) return false;
            return !seen.has(`${o.id}:${o.status}`);
          }).length;
          setOrderCount(unseenCount);
        }
      })
      .catch(() => {});
  }, [borrowerId]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (categoryId) params.set('categoryId', categoryId);
    if (merchantId) params.set('merchantId', merchantId);
    fetch(`/api/shop?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setItems(d.items || []);
        if (d.categories) setCategories(d.categories);
        if (d.merchants) setMerchants(d.merchants);
      });
  }, [search, categoryId, merchantId]);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (merchantSearchOpen && merchantSearchInputRef.current) {
      merchantSearchInputRef.current.focus();
    }
  }, [merchantSearchOpen]);

  const fmtCurr = (v: number) =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);

  const handleSelect = (itemId: string) => {
    const sp = new URLSearchParams();
    sp.set('borrowerId', borrowerId);
    sp.set('itemId', itemId);
    sp.set('qty', '1');
    router.push(`/loan?${sp.toString()}`);
  };

  const handleSearchClose = () => {
    setSearchOpen(false);
    setSearch('');
  };

  const handleMerchantSearchClose = () => {
    setMerchantSearchOpen(false);
    setMerchantSearch('');
  };

  const handleMerchantSelect = (id: string) => {
    setMerchantId((prev) => (prev === id ? '' : id));
  };

  const isNewItem = (item: any) => {
    if (!item.createdAt) return false;
    const created = new Date(item.createdAt);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - NEW_ITEM_DAYS);
    return created >= cutoff;
  };

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aNew = isNewItem(a) ? 1 : 0;
      const bNew = isNewItem(b) ? 1 : 0;
      if (bNew !== aNew) return bNew - aNew;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  }, [items]);

  const groupedItems = useMemo(() => {
    if (!merchantId) return null;
    const groups: Record<string, { name: string; items: any[] }> = {};
    for (const item of sortedItems) {
      const catName = item.category?.name || 'Uncategorized';
      const catId = item.category?.id || 'uncategorized';
      if (!groups[catId]) groups[catId] = { name: catName, items: [] };
      groups[catId].items.push(item);
    }
    return Object.values(groups);
  }, [sortedItems, merchantId]);

  const filteredMerchants = useMemo(() => {
    const query = merchantSearch.trim().toLowerCase();
    if (!query) return merchants;
    return merchants.filter((merchant) => merchant.name?.toLowerCase().includes(query));
  }, [merchantSearch, merchants]);

  const shouldExpandMerchants = showAllMerchants || merchantSearch.trim().length > 0;

  const visibleMerchants = shouldExpandMerchants
    ? filteredMerchants
    : filteredMerchants.slice(0, MAX_VISIBLE_MERCHANTS);
  const selectedMerchant = merchants.find((m) => m.id === merchantId);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100/80">
      {/* Header */}
      <div className="bg-shop px-4 pt-3 pb-5 sm:pt-4 sm:pb-6 shadow-md">
        <div className="max-w-7xl mx-auto">
          {/* Top row with title and orders */}
          <div className="flex items-center justify-between mb-3 sm:mb-4">
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Shop</h1>
            <div className="flex items-center gap-2">
              {/* Collapsible search */}
              <div
                className={`flex items-center transition-all duration-300 ease-in-out overflow-hidden ${
                  searchOpen ? 'w-48 sm:w-64' : 'w-0'
                }`}
              >
                <div className="relative w-full min-w-0">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    ref={searchInputRef}
                    className="pl-10 pr-8 bg-white border-0 shadow-md w-full h-9 sm:h-10 rounded-xl text-sm focus:ring-2 focus:ring-white/40 placeholder:text-gray-400"
                    placeholder="Search products..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') handleSearchClose(); }}
                  />
                  <button
                    onClick={handleSearchClose}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {!searchOpen && (
                <button
                  onClick={() => setSearchOpen(true)}
                  className="text-white/90 hover:text-white transition-colors p-1.5"
                  aria-label="Open search"
                >
                  <Search className="h-5 w-5" />
                </button>
              )}

              <Link
                href={`/bnpl/orders?borrowerId=${borrowerId}`}
                className="relative inline-flex items-center gap-1.5 text-white/90 hover:text-white font-medium text-sm transition-colors"
              >
                <ShoppingCart className="h-4 w-4" />
                Orders
                {orderCount > 0 && (
                  <span className="absolute -top-2 -right-3 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold px-1 shadow-md animate-in fade-in zoom-in">
                    {orderCount}
                  </span>
                )}
              </Link>
            </div>
          </div>

          {/* Category pills */}
          <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none -mx-1 px-1 snap-x snap-mandatory">
            <button
              onClick={() => setCategoryId('')}
              className={`shrink-0 snap-start px-3.5 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-all ${
                !categoryId
                  ? 'bg-white text-shop-deep shadow-md'
                  : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategoryId(c.id === categoryId ? '' : c.id)}
                className={`shrink-0 snap-start px-3.5 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-medium transition-all ${
                  categoryId === c.id
                    ? 'bg-white text-shop-deep shadow-md'
                    : 'bg-white/20 text-white hover:bg-white/30'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* Selected merchant indicator in header */}
          {selectedMerchant && (
            <div className="mt-2.5 flex items-center gap-2">
              <Badge className="bg-white/20 text-white border-0 gap-1.5 py-1 px-3 text-xs">
                <Store className="h-3 w-3" />
                {selectedMerchant.name}
                <button onClick={() => setMerchantId('')} className="ml-1 hover:text-white/70">
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-5 sm:py-10">
        {/* Merchant Section */}
        {merchants.length > 0 && (
          <div className="mb-6 sm:mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm sm:text-base font-semibold text-gray-900">Merchants</h2>
              <div className="flex items-center gap-2 sm:gap-3">
                <div
                  className={`flex items-center transition-all duration-300 ease-in-out overflow-hidden ${
                    merchantSearchOpen ? 'w-44 sm:w-56' : 'w-0'
                  }`}
                >
                  <div className="relative w-full min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      ref={merchantSearchInputRef}
                      value={merchantSearch}
                      onChange={(e) => setMerchantSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') handleMerchantSearchClose();
                      }}
                      placeholder="Search merchants..."
                      className="pl-10 pr-9 h-9 rounded-xl bg-white border-gray-200"
                    />
                    <button
                      type="button"
                      onClick={handleMerchantSearchClose}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      aria-label="Close merchant search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {!merchantSearchOpen && (
                  <button
                    type="button"
                    onClick={() => setMerchantSearchOpen(true)}
                    className="text-shop-text hover:text-shop-deep transition-colors p-1.5 rounded-lg hover:bg-shop-soft"
                    aria-label="Open merchant search"
                  >
                    <Search className="h-4 w-4" />
                  </button>
                )}
                {merchants.length > MAX_VISIBLE_MERCHANTS && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowAllMerchants((prev) => !prev);
                    }}
                    className="text-xs sm:text-sm text-shop-text hover:text-shop-deep font-medium flex items-center gap-0.5 transition-colors"
                  >
                    {showAllMerchants ? 'Show Less' : 'See All'}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div
              className={shouldExpandMerchants
                ? 'grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3'
                : 'flex gap-3 overflow-x-auto pb-2 scrollbar-none snap-x snap-mandatory -mx-1 px-1'}
              onScroll={!shouldExpandMerchants ? handleMerchantScroll : undefined}>
              {visibleMerchants.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleMerchantSelect(m.id)}
                  className={`flex flex-col items-center gap-1.5 ${shouldExpandMerchants ? 'w-full' : 'shrink-0 snap-start'} group focus:outline-none focus-visible:ring-2 focus-visible:ring-shop rounded-xl p-2 transition-all ${
                    merchantId === m.id
                      ? 'bg-shop-soft ring-2 ring-shop'
                      : 'hover:bg-gray-100'
                  }`}
                  aria-pressed={merchantId === m.id}
                  aria-label={`Filter by ${m.name}`}
                >
                  <div
                    className={`h-14 w-14 sm:h-16 sm:w-16 rounded-full flex items-center justify-center border-2 transition-all shadow-sm group-hover:shadow-md ${
                      merchantId === m.id
                        ? 'border-shop bg-white shadow-md'
                        : 'border-gray-200 bg-white'
                    }`}
                  >
                    {m.iconUrl ? (
                      <img
                        src={m.iconUrl}
                        alt={m.name}
                        className="h-8 w-8 sm:h-10 sm:w-10 rounded-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <Store
                        className={`h-5 w-5 sm:h-6 sm:w-6 ${
                          merchantId === m.id ? 'text-shop' : 'text-gray-400'
                        }`}
                      />
                    )}
                  </div>
                  <span
                    className={`text-[10px] sm:text-xs font-medium text-center max-w-[60px] sm:max-w-[72px] truncate ${
                      merchantId === m.id ? 'text-shop-deep' : 'text-muted-foreground'
                    }`}
                  >
                    {m.name}
                  </span>
                </button>
              ))}

              {merchants.length > MAX_VISIBLE_MERCHANTS && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAllMerchants((prev) => !prev);
                  }}
                  className={`flex flex-col items-center gap-1.5 ${shouldExpandMerchants ? 'w-full' : 'shrink-0 snap-start'} group focus:outline-none focus-visible:ring-2 focus-visible:ring-shop rounded-xl p-2 hover:bg-gray-100 transition-all`}
                >
                  <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-full flex items-center justify-center border-2 border-dashed border-gray-300 bg-white group-hover:border-shop group-hover:shadow-md transition-all">
                    <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6 text-gray-400 group-hover:text-shop transition-colors" />
                  </div>
                  <span className="text-[10px] sm:text-xs font-medium text-muted-foreground group-hover:text-shop-text transition-colors">
                    {showAllMerchants ? 'Show Less' : 'See All'}
                  </span>
                </button>
              )}
            </div>
            {!shouldExpandMerchants && merchants.length > 0 && (
              <div className="flex items-center justify-center gap-1.5 mt-3">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className={`h-1 rounded-full transition-all duration-300 ${
                      merchantScrollIndex === i
                        ? 'w-6 bg-shop'
                        : 'w-2 bg-gray-300'
                    }`}
                  />
                ))}
              </div>
            )}
            {merchantSearch.trim().length > 0 && filteredMerchants.length > 0 && (
              <p className="mt-3 text-xs text-gray-500">
                Showing {filteredMerchants.length} merchant{filteredMerchants.length === 1 ? '' : 's'}
              </p>
            )}
            {shouldExpandMerchants && filteredMerchants.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
                No merchants match your search.
              </div>
            )}
          </div>
        )}

        <div className="text-center mb-5 sm:mb-10">
          {hasActiveLoan ? (
            <Link
              href={`/loan?borrowerId=${borrowerId}`}
              className="mx-auto flex w-full max-w-lg items-center justify-between rounded-xl bg-shop px-4 py-3 text-white shadow-sm transition-colors hover:bg-shop-dark"
            >
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                <span className="text-sm font-semibold">You have an active loan</span>
              </div>
              <div className="flex items-center gap-1 text-xs font-semibold">
                View Dashboard
                <ChevronRight className="h-3.5 w-3.5" />
              </div>
            </Link>
          ) : (
            <>
              <h2 className="text-lg sm:text-2xl font-bold text-gray-900 tracking-tight">
                {selectedMerchant ? `${selectedMerchant.name} Products` : 'Browse Products'}
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">
                Browse and select items for BNPL or Direct Payment
              </p>
            </>
          )}
        </div>

        {sortedItems.length === 0 && (
          <div className="text-center py-20">
            <Package className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">No items found</p>
            <p className="text-xs text-gray-400 mt-1">Try a different search or category</p>
          </div>
        )}

        {groupedItems ? (
          groupedItems.map((group) => (
            <div key={group.name} className="mb-8">
              <h3 className="text-sm sm:text-base font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Badge variant="outline" className="text-xs">{group.name}</Badge>
                <span className="text-xs text-muted-foreground">({group.items.length})</span>
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5">
                {group.items.map((item) => (
                  <ShopProductCard key={item.id} item={item} fmtCurr={fmtCurr} isNew={isNewItem(item)} onSelect={handleSelect} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5">
            {sortedItems.map((item) => (
              <ShopProductCard key={item.id} item={item} fmtCurr={fmtCurr} isNew={isNewItem(item)} onSelect={handleSelect} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function getFirstImage(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  const trimmed = imageUrl.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0) return arr[0];
    } catch { /* ignore */ }
  }
  return trimmed;
}

function ShopProductCard({ item, fmtCurr, isNew, onSelect }: { item: any; fmtCurr: (v: number) => string; isNew: boolean; onSelect: (id: string) => void }) {
  const mainImage = getFirstImage(item.imageUrl);
  return (
    <Card className="group overflow-hidden border-0 shadow-sm hover:shadow-xl transition-all duration-300 rounded-xl bg-white">
      {/* Image */}
      <div className="relative aspect-square bg-gradient-to-br from-gray-50 to-gray-100 overflow-hidden">
        {mainImage ? (
          <img
            src={mainImage}
            alt={item.name}
            className="w-full h-full object-contain p-2 group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-300">
            <Package className="h-8 w-8 sm:h-10 sm:w-10 mb-1" />
            <span className="text-[10px] sm:text-xs">No Image</span>
          </div>
        )}

        {/* Discount badge */}
        {item.bestDiscount && (
          <div className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 flex items-center gap-0.5 bg-red-500 text-white text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md shadow-sm">
            <Tag className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
            {item.bestDiscount.type === 'PERCENTAGE'
              ? `${item.bestDiscount.value}%`
              : `-${fmtCurr(item.bestDiscount.value)}`}
          </div>
        )}

        {/* New badge */}
        {isNew && (
          <Badge className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 bg-emerald-500 text-white text-[9px] sm:text-[10px] shadow-sm">
            New
          </Badge>
        )}

        {/* Video badge */}
        {item.videoUrl && !isNew && (
          <a
            href={item.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 flex items-center gap-1 text-[10px] sm:text-xs font-medium text-shop-deep bg-white/90 backdrop-blur-sm rounded-full pl-1.5 pr-2 py-0.5 sm:pl-2 sm:pr-2.5 sm:py-1 shadow-sm hover:bg-white transition-colors"
          >
            <PlayCircle className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
            <span className="hidden sm:inline">Video</span>
          </a>
        )}
      </div>

      {/* Content */}
      <CardContent className="p-2.5 sm:p-4 space-y-1.5 sm:space-y-2">
        {/* Merchant badge */}
        <Badge
          variant="secondary"
          className="bg-shop-soft text-shop-deep border-0 text-[9px] sm:text-[10px] font-semibold px-1.5 sm:px-2 py-0 rounded-md uppercase tracking-wider"
        >
          {item.merchant?.name}
        </Badge>

        {/* Item name */}
        <h3 className="font-semibold text-gray-900 text-xs sm:text-sm leading-tight line-clamp-2">
          {item.name}
        </h3>

        {/* Price + Select */}
        <div className="pt-1.5 sm:pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[9px] sm:text-[10px] text-gray-400 font-medium uppercase tracking-wide">
                Price
              </p>
              {item.bestDiscount && item.discountedPrice != null ? (
                <div>
                  <p className="text-[10px] sm:text-xs text-gray-400 line-through">
                    {fmtCurr(item.price)} ETB
                  </p>
                  <p className="text-sm sm:text-base font-bold text-red-600">
                    {fmtCurr(item.discountedPrice)}
                    <span className="text-[9px] sm:text-[10px] font-normal text-gray-400 ml-0.5">
                      ETB
                    </span>
                  </p>
                </div>
              ) : (
                <p className="text-sm sm:text-base font-bold text-gray-900">
                  {fmtCurr(item.price)}
                  <span className="text-[9px] sm:text-[10px] font-normal text-gray-400 ml-0.5">
                    ETB
                  </span>
                </p>
              )}
            </div>
            <Button
              size="sm"
              className="bg-shop hover:bg-shop-dark text-white rounded-lg px-3 sm:px-4 h-7 sm:h-8 text-[10px] sm:text-xs font-semibold shadow-sm hover:shadow transition-all"
              onClick={() => onSelect(item.id)}
            >
              Select
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
