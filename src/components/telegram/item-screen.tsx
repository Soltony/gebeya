'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Minus, Package, Plus, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEtb } from '@/lib/marketplace/order-status';
import { useTelegram } from './telegram-provider';
import { useBackButton, useMainButton } from './use-telegram-buttons';
import { BackBar } from './back-bar';
import type { ItemDetail, OrderQuote } from './types';

const MAX_QUANTITY = 99;
const QUOTE_DEBOUNCE_MS = 250;

export function ItemScreen({ itemId }: { itemId: string }) {
  const router = useRouter();
  const { api, me, webApp, linkPhone, alert, confirm, haptic } = useTelegram();
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  const goBack = useCallback(() => {
    if (window.history.length > 1) router.back();
    else router.replace('/tg');
  }, [router]);
  const nativeBack = useBackButton(goBack);

  useEffect(() => {
    api<ItemDetail>(`/api/tg/catalog/${encodeURIComponent(itemId)}`)
      .then(setItem)
      .catch(e => setLoadError(e.message));
  }, [api, itemId]);

  const optionsComplete = !!item && item.optionGroups.every(g => selected[g.id]);

  const cart = useMemo(
    () => ({
      items: [
        {
          itemId,
          quantity,
          optionSelections: Object.values(selected).map(optionValueId => ({ optionValueId })),
        },
      ],
    }),
    [itemId, quantity, selected],
  );

  // The server quote is the amount the order will be placed for (quantity discounts included).
  useEffect(() => {
    if (!item?.orderable || !optionsComplete) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<{ quote: OrderQuote }>('/api/tg/orders/quote', { method: 'POST', body: JSON.stringify(cart) })
        .then(({ quote }) => {
          if (cancelled) return;
          setQuote(quote);
          setQuoteError(null);
        })
        .catch(e => {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(e.message);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, cart, item?.orderable, optionsComplete]);

  const estimatedTotal = useMemo(() => {
    if (!item) return 0;
    const deltas = item.optionGroups.reduce((sum, g) => sum + (g.values.find(v => v.id === selected[g.id])?.priceDelta ?? 0), 0);
    return (item.price + deltas) * quantity;
  }, [item, selected, quantity]);

  const total = quote?.totalAmount ?? estimatedTotal;
  const discount = quote ? quote.lines.reduce((sum, l) => sum + l.discountAmount, 0) : 0;

  const placeOrder = useCallback(async () => {
    if (!item || placing) return;
    if (!optionsComplete) {
      haptic('warning');
      await alert('Please choose all options first.');
      return;
    }
    if (!quote) return;

    if (!me?.phoneLinked) {
      const linked = await linkPhone();
      if (!linked) return;
    }

    const ok = await confirm(
      `Order ${quantity} × ${item.name} for ${formatEtb(quote.totalAmount)}?\n\n` +
        'No payment is taken now. The merchant will contact you about delivery.',
    );
    if (!ok) return;

    setPlacing(true);
    try {
      const { order } = await api<{ order: { id: string } }>('/api/tg/orders', { method: 'POST', body: JSON.stringify(cart) });
      haptic('success');
      router.replace(`/tg/orders/${order.id}?placed=1`);
    } catch (e: any) {
      haptic('error');
      await alert(e?.message || 'Could not place the order.');
      setPlacing(false);
    }
  }, [item, placing, optionsComplete, quote, me?.phoneLinked, linkPhone, confirm, quantity, api, cart, haptic, router, alert]);

  const mainButtonText = !optionsComplete ? 'Choose options' : `Order · ${formatEtb(total)}`;
  const nativeButton = useMainButton({
    text: mainButtonText,
    visible: Boolean(item?.orderable),
    enabled: optionsComplete && Boolean(quote),
    progress: placing,
    onClick: placeOrder,
  });

  const share = () => {
    if (!item?.shareLink) return;
    const url = `https://t.me/share/url?url=${encodeURIComponent(item.shareLink)}&text=${encodeURIComponent(item.name)}`;
    if (webApp) webApp.openTelegramLink(url);
    else window.open(url, '_blank');
  };

  const backBar = <BackBar onBack={goBack} hidden={nativeBack} title={item?.name} />;

  if (loadError) {
    return (
      <>
        {backBar}
        <p className="px-6 py-16 text-center text-sm tg-destructive">{loadError}</p>
      </>
    );
  }
  if (!item) {
    return (
      <>
        {backBar}
        <div className="space-y-3 p-4">
          <Skeleton className="aspect-square w-full rounded-2xl" />
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </>
    );
  }

  return (
    <>
    {backBar}
    <div className="space-y-3 p-4">
      <div className="tg-section overflow-hidden">
        <div className="relative aspect-square bg-black/5">
          {item.images.length > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.images[imageIndex]} alt={item.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Package className="h-12 w-12 tg-hint" />
            </div>
          )}
        </div>
        {item.images.length > 1 && (
          <div className="flex gap-2 overflow-x-auto p-2">
            {item.images.map((src, i) => (
              <button
                key={src + i}
                type="button"
                onClick={() => setImageIndex(i)}
                className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 ${i === imageIndex ? 'border-[#fdb913]' : 'border-transparent'}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="tg-section space-y-1 p-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-lg font-semibold leading-snug">{item.name}</h1>
          {item.shareLink && (
            <button type="button" onClick={share} className="tg-link shrink-0 p-1" aria-label="Share">
              <Share2 className="h-5 w-5" />
            </button>
          )}
        </div>
        <p className="text-sm tg-hint">
          {item.merchant.name}
          {item.category ? ` · ${item.category.name}` : ''}
        </p>
        <p className="pt-1 text-xl font-bold">{formatEtb(item.price)}</p>
        {item.bestDiscount && (
          <p className="text-xs font-medium text-red-500">
            {item.bestDiscount.type === 'PERCENTAGE'
              ? `${item.bestDiscount.value}% off — ${item.bestDiscount.name}`
              : `${formatEtb(item.bestDiscount.value)} off — ${item.bestDiscount.name}`}
          </p>
        )}
        {item.description && <p className="whitespace-pre-line pt-2 text-sm leading-relaxed">{item.description}</p>}
      </div>

      {!item.orderable ? (
        <div className="tg-section p-4 text-sm">
          <p className="font-medium">Available with pay-later only</p>
          <p className="mt-1 tg-hint">This item can be bought with BNPL in the Nib mobile app. Ordering it in Telegram is not available yet.</p>
        </div>
      ) : (
        <>
          {item.optionGroups.map(group => (
            <div key={group.id} className="tg-section space-y-2 p-4">
              <p className="text-sm font-medium">{group.name}</p>
              <div className="flex flex-wrap gap-2">
                {group.values.map(value => (
                  <button
                    key={value.id}
                    type="button"
                    data-active={selected[group.id] === value.id}
                    onClick={() => setSelected(prev => ({ ...prev, [group.id]: value.id }))}
                    className="tg-chip rounded-full px-3 py-1.5 text-sm"
                  >
                    {value.label}
                    {value.priceDelta ? ` (${value.priceDelta > 0 ? '+' : ''}${formatEtb(value.priceDelta)})` : ''}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="tg-section flex items-center justify-between p-4">
            <span className="text-sm font-medium">Quantity</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="tg-chip flex h-8 w-8 items-center justify-center rounded-full disabled:opacity-40"
                onClick={() => setQuantity(q => Math.max(1, q - 1))}
                disabled={quantity <= 1}
                aria-label="Decrease quantity"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-6 text-center font-semibold">{quantity}</span>
              <button
                type="button"
                className="tg-chip flex h-8 w-8 items-center justify-center rounded-full disabled:opacity-40"
                onClick={() => setQuantity(q => Math.min(MAX_QUANTITY, q + 1))}
                disabled={quantity >= MAX_QUANTITY}
                aria-label="Increase quantity"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="tg-section space-y-1 p-4 text-sm">
            {discount > 0 && (
              <div className="flex justify-between text-red-500">
                <span>Discount</span>
                <span>−{formatEtb(discount)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span>{formatEtb(total)}</span>
            </div>
            {quoteError && <p className="pt-1 text-xs tg-destructive">{quoteError}</p>}
            <p className="pt-1 text-xs tg-hint">
              {item.requiresMerchantConfirmation ? 'The merchant confirms availability before delivery. ' : ''}
              No payment is taken when you order.
            </p>
          </div>

          {!nativeButton && (
            <Button
              className="tg-primary-button h-11 w-full rounded-xl font-semibold"
              onClick={placeOrder}
              disabled={!optionsComplete || !quote || placing}
            >
              {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : mainButtonText}
            </Button>
          )}
        </>
      )}
    </div>
    </>
  );
}
