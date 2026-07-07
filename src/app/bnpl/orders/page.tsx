'use client';

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, ChevronUp, XCircle, AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';

declare global {
  interface Window {
    myJsChannel?: { postMessage: (msg: string) => void };
  }
}

const MERCHANT_RESPONDED_STATUSES = ['PENDING_DELIVERY', 'ON_DELIVERY', 'CANCELLED'];

const getSeenOrderResponsesKey = (borrowerId: string) => `bnpl_seen_order_responses:${borrowerId}`;

const orderStatusTabs = [
  {
    value: 'active',
    label: 'Active',
    statuses: ['PENDING', 'PENDING_MERCHANT_CONFIRMATION', 'CONFIRMED', 'SHIPPED', 'PENDING_DELIVERY', 'ON_DELIVERY'],
    empty: 'No active orders.',
  },
  {
    value: 'delivered',
    label: 'Delivered',
    statuses: ['DELIVERED'],
    empty: 'No delivered orders.',
  },
  {
    value: 'cancelled',
    label: 'Cancelled',
    statuses: ['CANCELLED'],
    empty: 'No cancelled orders.',
  },
] as const;

const statusColor: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  PENDING_MERCHANT_CONFIRMATION: 'bg-gray-100 text-gray-800 border-gray-300',
  ON_DELIVERY: 'bg-amber-100 text-amber-800 border-amber-300',
  CONFIRMED: 'bg-blue-100 text-blue-800 border-blue-300',
  SHIPPED: 'bg-purple-100 text-purple-800 border-purple-300',
  DELIVERED: 'bg-green-100 text-green-800 border-green-300',
  CANCELLED: 'bg-red-100 text-red-800 border-red-300',
};

import { Suspense } from 'react';

function BnplOrdersPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const borrowerId = searchParams?.get('borrowerId') || searchParams?.get('borrowerid') || '';
  const { toast } = useToast();
  const [orders, setOrders] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [activeTab, setActiveTab] = useState<(typeof orderStatusTabs)[number]['value']>('active');
  const [seenOrderResponses, setSeenOrderResponses] = useState<Set<string>>(new Set());

  // Delivery confirmation flow state
  const [deliveryOrderId, setDeliveryOrderId] = useState<string | null>(null);
  const [deliveryStep, setDeliveryStep] = useState<'agreement' | 'otp' | 'idle'>('idle');
  const [agreementContent, setAgreementContent] = useState('');
  const [agreementAccepted, setAgreementAccepted] = useState(false);
  const [loadingAgreement, setLoadingAgreement] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [paymentProcessing, setPaymentProcessing] = useState(false);

  const load = () => {
    if (!borrowerId) return;
    fetch(`/api/bnpl/orders?borrowerId=${encodeURIComponent(borrowerId)}`)
      .then(r => r.json())
      .then(data => setOrders(Array.isArray(data) ? data : []));
  };

  useEffect(() => { load(); }, [borrowerId]);

  useEffect(() => {
    if (!borrowerId) return;
    const stored = window.localStorage.getItem(getSeenOrderResponsesKey(borrowerId));
    setSeenOrderResponses(new Set<string>(stored ? JSON.parse(stored) : []));
  }, [borrowerId]);

  useEffect(() => {
    if (!borrowerId) return;
    const tab = orderStatusTabs.find((entry) => entry.value === activeTab);
    if (!tab) return;

    const nextSeen = new Set(seenOrderResponses);
    let changed = false;

    for (const order of orders) {
      if (!tab.statuses.includes(order.status)) continue;
      if (!MERCHANT_RESPONDED_STATUSES.includes(order.status)) continue;
      const signature = `${order.id}:${order.status}`;
      if (!nextSeen.has(signature)) {
        nextSeen.add(signature);
        changed = true;
      }
    }

    if (!changed) return;
    const serialized = JSON.stringify(Array.from(nextSeen));
    window.localStorage.setItem(getSeenOrderResponsesKey(borrowerId), serialized);
    setSeenOrderResponses(nextSeen);
  }, [activeTab, borrowerId, orders, seenOrderResponses]);

  // Auto-expand first order
  useEffect(() => {
    if (orders.length > 0 && Object.keys(expanded).length === 0) {
      setExpanded({ [orders[0].id]: true });
    }
  }, [orders]);

  const toggle = (id: string) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtCurr = (v: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);

  const confirmDelivered = async (orderId: string) => {
    setConfirming(orderId);
    try {
      const res = await fetch('/api/bnpl/orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: orderId, status: 'DELIVERED' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to confirm delivery');
      }
      const order = orders.find(o => o.id === orderId);
      const isDirectPayment = order?.paymentType === 'DIRECT';
      toast({
        title: 'Delivery confirmed',
        description: isDirectPayment
          ? 'Your order has been marked as delivered.'
          : 'Your order has been marked as delivered and the loan has been disbursed.',
      });
      load();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setConfirming(null);
    }
  };

  // Step 1: User clicks "Confirm delivered" → fetch agreement and show it
  const startDeliveryConfirmation = async (orderId: string) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    setDeliveryOrderId(orderId);
    setAgreementAccepted(false);
    setOtpCode('');
    setLoadingAgreement(true);
    setDeliveryStep('agreement');

    try {
      // Get the provider ID from the order's loan application product
      const providerId = order.loanApplication?.product?.providerId;
      if (providerId) {
        const res = await fetch(`/api/bnpl/delivery-agreement?providerId=${encodeURIComponent(providerId)}`);
        const data = await res.json();
        setAgreementContent(data?.content || '');
      } else {
        setAgreementContent('');
      }
    } catch {
      setAgreementContent('');
    } finally {
      setLoadingAgreement(false);
    }
  };

  // Step 2: Agreement accepted → handle based on payment type
  const handleAgreementAccepted = async () => {
    if (!deliveryOrderId) return;
    const order = orders.find(o => o.id === deliveryOrderId);
    if (!order) return;

    if (order.paymentType === 'DIRECT') {
      // Direct payment: initiate mini app payment, then confirm delivery
      await handleDirectPayment(order);
    } else {
      // BNPL: send OTP, then verify, then confirm delivery
      await sendDeliveryOtp(deliveryOrderId);
    }
  };

  // BNPL flow: send OTP
  const sendDeliveryOtp = async (orderId: string) => {
    setOtpSending(true);
    try {
      const res = await fetch('/api/delivery-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to send OTP');
      }
      toast({ title: 'OTP Sent', description: 'A verification code has been sent to your phone.' });
      setDeliveryStep('otp');
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setOtpSending(false);
    }
  };

  // BNPL flow: verify OTP then confirm delivery
  const verifyOtpAndConfirm = async () => {
    if (!deliveryOrderId || !otpCode) return;
    setOtpVerifying(true);
    try {
      const verifyRes = await fetch('/api/delivery-otp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: deliveryOrderId, code: otpCode }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Invalid or expired OTP');
      }
      // OTP verified, confirm delivery
      await confirmDelivered(deliveryOrderId);
      closeDeliveryDialog();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setOtpVerifying(false);
    }
  };

  // Direct payment flow: initiate payment through the NIB payment gateway (mini app)
  const handleDirectPayment = async (order: any) => {
    setPaymentProcessing(true);
    try {
      // Call the dedicated direct-payment initiation API
      const res = await fetch('/api/direct-payment/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          amount: order.totalAmount,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to initiate payment.');
      }

      const { paymentToken, transactionId } = await res.json();

      // Post payment token to Super App mini app channel
      if (typeof window !== 'undefined' && window.myJsChannel?.postMessage) {
        window.myJsChannel.postMessage(JSON.stringify({
          action: 'pay',
          paymentToken,
          transactionId,
          orderId: order.id,
          amount: order.totalAmount,
          currency: order.currency || 'ETB',
          merchantName: order.merchant?.name || '',
        }));

        closeDeliveryDialog();
        toast({
          title: 'Processing Payment',
          description: 'Your payment request has been sent. You will be notified once it is confirmed.',
        });
      } else {
        throw new Error('Could not communicate with the payment app. Please open this page inside the Super App.');
      }
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setPaymentProcessing(false);
    }
  };

  const closeDeliveryDialog = () => {
    setDeliveryOrderId(null);
    setDeliveryStep('idle');
    setAgreementContent('');
    setAgreementAccepted(false);
    setOtpCode('');
  };

  const openCancelDialog = (orderId: string) => {
    setCancelOrderId(orderId);
    setCancelReason('');
    setCancelDialogOpen(true);
  };

  const cancelOrder = async () => {
    if (!cancelOrderId) return;
    setCancelling(true);
    try {
      const res = await fetch('/api/bnpl/orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cancelOrderId, status: 'CANCELLED', cancelReason: cancelReason || 'Cancelled by borrower' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to cancel order');
      }
      toast({ title: 'Order cancelled', description: 'Your order has been cancelled successfully.' });
      setCancelDialogOpen(false);
      load();
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    } finally {
      setCancelling(false);
    }
  };

  // Get first item for summary display
  const getFirstItem = (o: any) => {
    const first = o.orderItems?.[0];
    if (!first) return { name: 'Order', imageUrl: null };
    const raw = first.item?.imageUrl;
    let imageUrl = raw || null;
    // imageUrl may be a JSON array like '["url1","url2"]'
    if (imageUrl && imageUrl.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(imageUrl);
        imageUrl = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
      } catch { /* use raw */ }
    }
    return { name: first.item?.name || 'Item', imageUrl };
  };

  const getOrdersForTab = (tabValue: (typeof orderStatusTabs)[number]['value']) => {
    const tab = orderStatusTabs.find((entry) => entry.value === tabValue);
    if (!tab) return orders;
    return orders.filter((order) => tab.statuses.includes(order.status));
  };

  const getTabNotificationCount = (tabValue: (typeof orderStatusTabs)[number]['value']) => {
    const tab = orderStatusTabs.find((entry) => entry.value === tabValue);
    if (!tab) return 0;

    return orders.filter((order) => {
      if (!tab.statuses.includes(order.status)) return false;
      if (!MERCHANT_RESPONDED_STATUSES.includes(order.status)) return false;
      return !seenOrderResponses.has(`${order.id}:${order.status}`);
    }).length;
  };

  const renderOrders = (tabValue: (typeof orderStatusTabs)[number]['value']) => {
    const tabOrders = getOrdersForTab(tabValue);
    const emptyMessage = orderStatusTabs.find((entry) => entry.value === tabValue)?.empty || 'No orders found.';

    if (tabOrders.length === 0) {
      return (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {emptyMessage}
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="space-y-4">
        {tabOrders.map(o => {
          const isOpen = expanded[o.id] || false;
          const firstItem = getFirstItem(o);
          return (
            <Card key={o.id} className="overflow-hidden">
              <button
                onClick={() => toggle(o.id)}
                className="w-full flex items-center gap-4 p-4 hover:bg-gray-50 transition-colors text-left"
              >
                {firstItem.imageUrl && (
                  <img
                    src={firstItem.imageUrl}
                    alt={firstItem.name}
                    className="w-12 h-12 rounded-lg object-cover border"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold truncate">{firstItem.name}</p>
                  <Badge className={o.paymentType === 'DIRECT' ? 'bg-emerald-100 text-emerald-800 border-emerald-300 text-[10px]' : 'bg-amber-100 text-amber-800 border-amber-300 text-[10px]'} variant="outline">
                    {o.paymentType === 'DIRECT' ? 'Direct Payment' : 'BNPL'}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold whitespace-nowrap">{fmtCurr(o.totalAmount)} ETB</span>
                  {isOpen ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
                </div>
              </button>

              {isOpen && (
                <div className="border-t px-4 pb-4">
                  <div className="pt-4 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <Badge className={statusColor[o.status] || ''} variant="outline">{o.status}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Payment Type</span>
                      <Badge className={o.paymentType === 'DIRECT' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300'} variant="outline">
                        {o.paymentType === 'DIRECT' ? 'Direct Payment' : 'BNPL'}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Order ID</span>
                      <span className="font-mono text-xs">{o.id}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Date</span>
                      <span>{fmtDate(o.createdAt)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Merchant</span>
                      <span>{o.merchant?.name}</span>
                    </div>
                    {o.merchant?.contactPersonPhone && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Contact</span>
                        <span className="text-right text-xs">
                          {o.merchant.contactPersonName && <span>{o.merchant.contactPersonName} &middot; </span>}
                          {o.merchant.contactPersonPhone}
                          {o.merchant.contactPersonEmail && <span> &middot; {o.merchant.contactPersonEmail}</span>}
                        </span>
                      </div>
                    )}
                    {o.merchant?.additionalContactInfo && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Location</span>
                        <span className="text-right text-xs max-w-[60%]">{o.merchant.additionalContactInfo}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Items</span>
                      <span>
                        {o.orderItems?.map((it: any) => (
                          <span key={it.id}>{it.quantity}&times; {it.item?.name}</span>
                        ))}
                      </span>
                    </div>
                  </div>

                  {o.status === 'CANCELLED' && o.cancelReason && (
                    <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                      <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-red-700">Order Cancelled</p>
                        <p className="text-xs text-red-600 mt-0.5">
                          {o.cancelledBy === 'MERCHANT' ? 'Reason from merchant: ' : 'Reason: '}
                          {o.cancelReason}
                        </p>
                      </div>
                    </div>
                  )}

                  {o.status === 'ON_DELIVERY' && (
                    <div className="mt-4 flex gap-2 justify-center">
                      <Button
                        onClick={() => startDeliveryConfirmation(o.id)}
                        disabled={confirming === o.id}
                        variant="outline"
                        className="px-6"
                      >
                        {confirming === o.id ? 'Confirming...' : 'Confirm delivered'}
                      </Button>
                    </div>
                  )}

                  {o.status !== 'DELIVERED' && o.status !== 'CANCELLED' && (
                    <div className="mt-4 flex justify-center">
                      <Button
                        onClick={() => openCancelDialog(o.id)}
                        variant="outline"
                        className="px-6 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                      >
                        <XCircle className="h-4 w-4 mr-1.5" />
                        Cancel Order
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.back()}
              className="p-2"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-3xl font-bold">My Orders</h1>
          </div>
          <p className="text-muted-foreground ml-12">Track BNPL order status and confirm delivery.</p>
        </div>

        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-xl">Orders</CardTitle>
            <p className="text-sm text-muted-foreground">Borrower: {borrowerId}</p>
          </CardHeader>
        </Card>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as (typeof orderStatusTabs)[number]['value'])} className="w-full">
          <TabsList className="mb-4 flex h-auto w-full gap-2 overflow-x-auto bg-transparent p-0">
            {orderStatusTabs.map((tab) => {
              const count = getOrdersForTab(tab.value).length;
              const notificationCount = getTabNotificationCount(tab.value);
              return (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="relative shrink-0 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 data-[state=active]:border-amber-500 data-[state=active]:bg-amber-500 data-[state=active]:text-white"
                >
                  {tab.label} ({count})
                  {notificationCount > 0 && (
                    <span className="ml-2 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white data-[state=active]:bg-white data-[state=active]:text-red-500">
                      {notificationCount}
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {orderStatusTabs.map((tab) => (
            <TabsContent key={tab.value} value={tab.value} className="mt-0">
              {renderOrders(tab.value)}
            </TabsContent>
          ))}
        </Tabs>

        {/* Cancel confirmation dialog */}
        <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel Order</DialogTitle>
              <DialogDescription>
                Are you sure you want to cancel this order? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">Reason (optional)</label>
              <Textarea
                placeholder="Why are you cancelling this order?"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setCancelDialogOpen(false)} disabled={cancelling}>
                Keep Order
              </Button>
              <Button variant="destructive" onClick={cancelOrder} disabled={cancelling}>
                {cancelling ? 'Cancelling...' : 'Cancel Order'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delivery Agreement Dialog */}
        <Dialog open={deliveryStep === 'agreement'} onOpenChange={(open) => { if (!open) closeDeliveryDialog(); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Delivery Agreement</DialogTitle>
              <DialogDescription>
                Please read and accept the delivery agreement to proceed.
              </DialogDescription>
            </DialogHeader>
            {loadingAgreement ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : agreementContent ? (
              <ScrollArea className="max-h-[300px] rounded-md border p-4">
                <div className="prose prose-sm max-w-none text-sm whitespace-pre-wrap">{agreementContent}</div>
              </ScrollArea>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">No delivery agreement configured.</p>
            )}
            <div className="flex items-center gap-2 mt-2">
              <Checkbox
                id="accept-delivery-agreement"
                checked={agreementAccepted}
                onCheckedChange={(v) => setAgreementAccepted(v === true)}
              />
              <label htmlFor="accept-delivery-agreement" className="text-sm cursor-pointer">
                I have read and accept the delivery agreement
              </label>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={closeDeliveryDialog}>
                Cancel
              </Button>
              <Button
                onClick={handleAgreementAccepted}
                disabled={!agreementAccepted || otpSending || paymentProcessing}
              >
                {otpSending || paymentProcessing ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Processing...</>
                ) : (
                  'Continue'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* OTP Verification Dialog (BNPL only) */}
        <Dialog open={deliveryStep === 'otp'} onOpenChange={(open) => { if (!open) closeDeliveryDialog(); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Enter Verification Code</DialogTitle>
              <DialogDescription>
                A 6-digit code has been sent to your phone. Enter it below to confirm delivery.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <Input
                placeholder="Enter 6-digit OTP"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                className="text-center text-lg tracking-widest font-mono"
                autoFocus
              />
              <Button
                variant="link"
                className="text-xs p-0 h-auto"
                onClick={() => deliveryOrderId && sendDeliveryOtp(deliveryOrderId)}
                disabled={otpSending}
              >
                {otpSending ? 'Sending...' : 'Resend OTP'}
              </Button>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={closeDeliveryDialog}>
                Cancel
              </Button>
              <Button
                onClick={verifyOtpAndConfirm}
                disabled={otpCode.length !== 6 || otpVerifying || confirming !== null}
              >
                {otpVerifying || confirming !== null ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Verifying...</>
                ) : (
                  'Confirm Delivery'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );

}

export default function BnplOrdersPage() {
  return (
    <Suspense fallback={<div>Loading orders...</div>}>
      <BnplOrdersPageInner />
    </Suspense>
  );
}
