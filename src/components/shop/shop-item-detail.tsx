'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PlayCircle, ShoppingCart, Minus, Plus, Package, ArrowLeft, ChevronRight, Percent, Tag, CreditCard, Banknote } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';

const MERCHANT_RESPONDED_STATUSES = ['PENDING_DELIVERY', 'ON_DELIVERY', 'CANCELLED'];

const getSeenOrderResponsesKey = (borrowerId: string) => `bnpl_seen_order_responses:${borrowerId}`;

function parseImages(imageUrl: string | null | undefined): string[] {
  if (!imageUrl) return [];
  const trimmed = imageUrl.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.filter((s: any) => typeof s === 'string' && s);
    } catch { /* ignore */ }
  }
  if (trimmed) return [trimmed];
  return [];
}

export function ShopItemDetail() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const borrowerId = searchParams?.get('borrowerId') || '';
  const itemId = searchParams?.get('itemId') || '';
  const qtyParam = parseInt(searchParams?.get('qty') || '1', 10) || 1;
  const optionValueIdsParam = searchParams?.get('optionValueIds') || '';

  const [item, setItem] = useState<any>(null);
  const [quantity, setQuantity] = useState(qtyParam);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [orderCount, setOrderCount] = useState(0);
  const [placingOrder, setPlacingOrder] = useState(false);
  const [selectedImageIdx, setSelectedImageIdx] = useState(0);

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
    if (!itemId) return;
    fetch(`/api/shop/${itemId}`)
      .then((r) => r.json())
      .then((data) => {
        setItem(data);
        if (optionValueIdsParam && data.optionGroups) {
          const valueIds = optionValueIdsParam.split(',');
          const opts: Record<string, string> = {};
          for (const group of data.optionGroups || []) {
            for (const val of group.values || []) {
              if (valueIds.includes(val.id)) {
                opts[group.id] = val.id;
              }
            }
          }
          setSelectedOptions(opts);
        }
      });
  }, [itemId, optionValueIdsParam]);

  const fmtCurr = (v: number) =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);

  // Get the best applicable discount (respects minQuantity)
  const activeDiscount = useMemo(() => {
    if (!item?.bestDiscount) return null;
    // Check minQuantity from the discount rules
    const applicableRules = (item.discountRules || []).filter(
      (r: any) => (r.minQuantity || 1) <= quantity
    );
    if (applicableRules.length === 0) return null;

    // Pick the best one
    let best: any = null;
    let bestEffective = 0;
    for (const d of applicableRules) {
      const t = (d.type || '').toUpperCase();
      let effective = 0;
      if (t === 'PERCENTAGE') effective = (Number(item.price) * d.value) / 100;
      else if (t === 'FIXED') effective = d.value;
      if (effective > bestEffective) {
        bestEffective = effective;
        best = { type: t, value: d.value, name: d.name };
      }
    }
    return best;
  }, [item, quantity]);

  const originalPrice = useMemo(() => {
    if (!item) return 0;
    let base = Number(item.price);
    for (const groupId of Object.keys(selectedOptions)) {
      const group = item.optionGroups?.find((g: any) => g.id === groupId);
      const val = group?.values?.find((v: any) => v.id === selectedOptions[groupId]);
      if (val?.priceDelta) base += Number(val.priceDelta);
    }
    return Math.max(0, base) * quantity;
  }, [item, selectedOptions, quantity]);

  const totalPrice = useMemo(() => {
    if (!item) return 0;
    let base = Number(item.price);
    for (const groupId of Object.keys(selectedOptions)) {
      const group = item.optionGroups?.find((g: any) => g.id === groupId);
      const val = group?.values?.find((v: any) => v.id === selectedOptions[groupId]);
      if (val?.priceDelta) base += Number(val.priceDelta);
    }
    // Apply discount
    if (activeDiscount) {
      if (activeDiscount.type === 'PERCENTAGE') base -= base * (activeDiscount.value / 100);
      else if (activeDiscount.type === 'FIXED') base -= activeDiscount.value;
    }
    return Math.max(0, base) * quantity;
  }, [item, selectedOptions, quantity, activeDiscount]);

  const savedAmount = originalPrice - totalPrice;

  const handleChangeItem = () => {
    const sp = new URLSearchParams();
    sp.set('borrowerId', borrowerId);
    router.push(`/loan?${sp.toString()}`);
  };

  const handleChooseLoanProduct = () => {
    const sp = new URLSearchParams();
    sp.set('borrowerId', borrowerId);
    sp.set('itemId', itemId);
    sp.set('qty', String(quantity));
    sp.set('amount', String(totalPrice));
    const optIds = Object.values(selectedOptions).filter(Boolean);
    if (optIds.length > 0) sp.set('optionValueIds', optIds.join(','));
    sp.set('step', 'products');
    router.push(`/loan?${sp.toString()}`);
  };

  const handlePlaceDirectOrder = async () => {
    if (placingOrder) return;
    setPlacingOrder(true);
    try {
      const optionSelections = Object.values(selectedOptions)
        .filter(Boolean)
        .map((vid) => ({ optionValueId: vid }));

      const res = await fetch('/api/bnpl/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          borrowerId,
          merchantId: item.merchantId || item.merchant?.id,
          items: [{ itemId, quantity, optionSelections }],
          paymentType: 'DIRECT',
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to place order.');
      }

      router.push(`/bnpl/orders?borrowerId=${encodeURIComponent(borrowerId)}`);
    } catch (e: any) {
      alert(e.message || 'Failed to place order');
    } finally {
      setPlacingOrder(false);
    }
  };

  if (!item) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100/80 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-shop-pale border-t-shop" />
          <p className="text-sm text-gray-400">Loading product...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100/80">
      {/* Header */}
      <div className="bg-shop px-4 py-3 sm:py-4 shadow-md">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={handleChangeItem}
              className="text-white/80 hover:text-white transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Shop</h1>
          </div>
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

      {/* Content */}
      <div className="max-w-lg mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <Card className="border-0 shadow-lg rounded-2xl overflow-hidden bg-white">
          {/* Image */}
          <div className="relative bg-gradient-to-br from-gray-50 via-white to-gray-100">
            {(() => {
              const images = parseImages(item.imageUrl);
              if (images.length === 0) {
                return (
                  <div className="aspect-[4/3] flex flex-col items-center justify-center text-gray-300">
                    <Package className="h-12 w-12 mb-2" />
                    <span className="text-sm">No Image</span>
                  </div>
                );
              }
              if (images.length === 1) {
                return (
                  <div className="aspect-[4/3] p-4 sm:p-6">
                    <div className="rounded-xl overflow-hidden h-full">
                      <img src={images[0]} alt={item.name} className="w-full h-full object-contain" />
                    </div>
                  </div>
                );
              }
              return (
                <div>
                  {/* Horizontal scrollable image carousel */}
                  <div
                    className="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide"
                    style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      const idx = Math.round(el.scrollLeft / el.clientWidth);
                      setSelectedImageIdx(idx);
                    }}
                  >
                    {images.map((img: string, i: number) => (
                      <div key={i} className="shrink-0 w-full snap-center aspect-[4/3] p-4 sm:p-6">
                        <div className="rounded-xl overflow-hidden h-full">
                          <img src={img} alt={`${item.name} ${i + 1}`} className="w-full h-full object-contain" />
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Dot indicators */}
                  <div className="flex justify-center gap-1.5 pb-3">
                    {images.map((_: string, i: number) => (
                      <span
                        key={i}
                        className={`h-2 rounded-full transition-all duration-200 ${
                          i === selectedImageIdx ? 'w-5 bg-shop' : 'w-2 bg-gray-300'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Discount badge */}
            {activeDiscount && (
              <div className="absolute top-3 left-3 flex items-center gap-1 bg-red-500 text-white text-xs font-bold px-2.5 py-1.5 rounded-lg shadow-md">
                <Tag className="h-3.5 w-3.5" />
                {activeDiscount.type === 'PERCENTAGE'
                  ? `${activeDiscount.value}% OFF`
                  : `${fmtCurr(activeDiscount.value)} ETB OFF`}
              </div>
            )}

            {/* Video badge */}
            {item.videoUrl && (
              <a
                href={item.videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute top-3 right-3 flex items-center gap-1.5 text-xs font-medium text-shop-deep bg-white/90 backdrop-blur-sm rounded-full pl-2.5 pr-3 py-1.5 shadow-sm hover:bg-white transition-colors"
              >
                <PlayCircle className="h-4 w-4" />
                Watch video
              </a>
            )}
          </div>

          <CardContent className="px-4 sm:px-6 pb-5 sm:pb-6 pt-0 space-y-4">
            {/* Merchant & Category */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="secondary"
                className="bg-shop-soft text-shop-deep border-0 text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded-md uppercase tracking-wider"
              >
                {item.merchant?.name}
              </Badge>
              {item.category && (
                <Badge
                  variant="secondary"
                  className="bg-gray-100 text-gray-600 border-0 text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-md"
                >
                  {item.category.name}
                </Badge>
              )}
            </div>

            {/* Name + Quantity */}
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg sm:text-xl font-bold text-gray-900 leading-tight">
                {item.name}
              </h3>
              <div className="flex items-center gap-1.5 bg-gray-50 rounded-full px-1 py-0.5 border border-gray-200 shrink-0">
                <button
                  className="w-7 h-7 rounded-full flex items-center justify-center text-gray-500 hover:bg-white hover:shadow-sm transition-all active:scale-95"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="text-sm font-semibold text-gray-900 w-6 text-center tabular-nums">
                  {quantity}
                </span>
                <button
                  className="w-7 h-7 rounded-full flex items-center justify-center text-gray-500 hover:bg-white hover:shadow-sm transition-all active:scale-95"
                  onClick={() => setQuantity((q) => q + 1)}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Description */}
            {item.description && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Description
                </p>
                <div className="max-h-24 overflow-y-auto rounded-lg bg-gray-50 px-3 py-2 border border-gray-100 scrollbar-thin">
                  <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                    {item.description}
                  </p>
                </div>
              </div>
            )}

            {/* Option groups */}
            {item.optionGroups?.length > 0 && (
              <div className="space-y-3 pt-1">
                {item.optionGroups.map((group: any) => (
                  <div key={group.id}>
                    <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      {group.name}
                    </label>
                    <Select
                      value={selectedOptions[group.id] || ''}
                      onValueChange={(v) =>
                        setSelectedOptions({ ...selectedOptions, [group.id]: v })
                      }
                    >
                      <SelectTrigger className={`mt-1.5 rounded-xl bg-gray-50/80 focus:bg-white focus:ring-2 focus:ring-shop/20 focus:border-shop transition-all h-11 ${
                        !selectedOptions[group.id] ? 'border-red-300 ring-1 ring-red-200' : 'border-gray-200'
                      }`}>
                        <SelectValue placeholder={`Select ${group.name}`} />
                      </SelectTrigger>
                      <SelectContent>
                        {group.values?.map((v: any) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.label}
                            {v.priceDelta
                              ? ` (+${fmtCurr(Number(v.priceDelta))} ETB)`
                              : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            )}

            {/* Total */}
            {activeDiscount && savedAmount > 0 ? (
              <div className="rounded-xl overflow-hidden">
                {/* Discount banner */}
                <div className="bg-red-500 px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-white">
                    <Percent className="h-3.5 w-3.5" />
                    <span className="text-xs font-semibold">
                      {activeDiscount.type === 'PERCENTAGE'
                        ? `${activeDiscount.value}% Discount Applied`
                        : `${fmtCurr(activeDiscount.value)} ETB Discount Applied`}
                    </span>
                  </div>
                  <span className="text-xs font-bold text-white">
                    You save {fmtCurr(savedAmount)} ETB
                  </span>
                </div>
                {/* Price area */}
                <div className="bg-gradient-to-r from-shop-soft to-shop-pale px-4 py-3 flex items-center justify-between">
                  <span className="text-sm font-medium text-shop-deeper">Total</span>
                  <div className="text-right">
                    <span className="text-xs text-gray-400 line-through mr-2">
                      {fmtCurr(originalPrice)} ETB
                    </span>
                    <span className="text-xl sm:text-2xl font-bold text-red-600">
                      {fmtCurr(totalPrice)}
                    </span>
                    <span className="text-xs font-medium text-gray-500 ml-1">ETB</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-gradient-to-r from-shop-soft to-shop-pale rounded-xl px-4 py-3 flex items-center justify-between">
                <span className="text-sm font-medium text-shop-deeper">Total</span>
                <div className="text-right">
                  <span className="text-xl sm:text-2xl font-bold text-gray-900">
                    {fmtCurr(totalPrice)}
                  </span>
                  <span className="text-xs font-medium text-gray-500 ml-1">ETB</span>
                </div>
              </div>
            )}

            {/* Actions */}
            {item.optionGroups?.length > 0 && item.optionGroups.some((g: any) => !selectedOptions[g.id]) && (
              <p className="text-xs text-red-500 font-medium text-center">
                Please select all options above to continue
              </p>
            )}

            {(() => {
              const optionsIncomplete = item.optionGroups?.length > 0 && item.optionGroups.some((g: any) => !selectedOptions[g.id]);
              const sellingOption = item.sellingOption || 'BNPL_ONLY';

              if (sellingOption === 'BOTH') {
                return (
                  <div className="space-y-3 pt-1">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Choose payment method</p>
                    <div className="flex items-center gap-2">
                      <Button
                        className="flex-1 bg-shop hover:bg-shop-dark text-white rounded-xl h-11 font-semibold text-sm shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleChooseLoanProduct}
                        disabled={optionsIncomplete}
                      >
                        <CreditCard className="h-4 w-4 mr-1.5" />
                        BNPL
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                      <Button
                        className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl h-11 font-semibold text-sm shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handlePlaceDirectOrder}
                        disabled={optionsIncomplete || placingOrder}
                      >
                        <Banknote className="h-4 w-4 mr-1.5" />
                        {placingOrder ? 'Placing...' : 'Direct Pay'}
                      </Button>
                    </div>
                  </div>
                );
              }

              if (sellingOption === 'DIRECT_ONLY') {
                return (
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl h-11 font-semibold text-sm shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handlePlaceDirectOrder}
                      disabled={optionsIncomplete || placingOrder}
                    >
                      <Banknote className="h-4 w-4 mr-1.5" />
                      {placingOrder ? 'Placing order...' : 'Place order'}
                      {!placingOrder && <ChevronRight className="h-4 w-4 ml-1" />}
                    </Button>
                  </div>
                );
              }

              // Default: BNPL_ONLY
              return (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    className="flex-1 bg-shop hover:bg-shop-dark text-white rounded-xl h-11 font-semibold text-sm shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    onClick={handleChooseLoanProduct}
                    disabled={optionsIncomplete}
                  >
                    Place order
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
