'use client';

import dynamic from 'next/dynamic';
import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useRequirePermission } from '@/hooks/use-require-permission';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react';
import { extractErrorMessage } from '@/lib/fetch-utils';

type CancelDialogProps = {
  open: boolean;
  orderId: string;
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
};

const MerchantOrderCancelDialog = dynamic<CancelDialogProps>(
  () => import('@/app/admin/merchants/orders/cancel-order-dialog').then((module) => module.default),
);

const ALL_FILTER_VALUE = 'ALL';
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = ['10', '20', '50', '100'] as const;
const STATUS_FILTER_OPTIONS = [
  ALL_FILTER_VALUE,
  'PENDING',
  'PENDING_MERCHANT_CONFIRMATION',
  'CONFIRMED',
  'ON_DELIVERY',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
] as const;
const PAYMENT_TYPE_OPTIONS = [ALL_FILTER_VALUE, 'BNPL', 'DIRECT'] as const;

const statusColor: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  PENDING_MERCHANT_CONFIRMATION: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  ON_DELIVERY: 'bg-amber-100 text-amber-800 border-amber-300',
  CONFIRMED: 'bg-blue-100 text-blue-800 border-blue-300',
  SHIPPED: 'bg-purple-100 text-purple-800 border-purple-300',
  DELIVERED: 'bg-green-100 text-green-800 border-green-300',
  CANCELLED: 'bg-red-100 text-red-800 border-red-300',
};

type MerchantOrderRow = {
  id: string;
  borrowerId: string;
  totalAmount: number;
  currency: string;
  paymentType: string;
  status: string;
  cancelReason: string | null;
  createdAt: string;
  merchant: {
    id: string;
    name: string;
  } | null;
  orderItems: Array<{
    id: string;
    item: {
      name: string;
    } | null;
    optionSelections: Array<{
      id: string;
      optionValue: {
        label: string;
        group: {
          name: string;
        } | null;
      } | null;
    }>;
  }>;
};

type PaginationState = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

type MerchantOrdersResponse = {
  data: MerchantOrderRow[];
  pagination: PaginationState;
};

const DEFAULT_PAGINATION: PaginationState = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};

function buildOrdersQuery(params: {
  page: number;
  pageSize: number;
  search: string;
  status: string;
  paymentType: string;
}) {
  const searchParams = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });

  if (params.search) {
    searchParams.set('search', params.search);
  }

  if (params.status && params.status !== ALL_FILTER_VALUE) {
    searchParams.set('status', params.status);
  }

  if (params.paymentType && params.paymentType !== ALL_FILTER_VALUE) {
    searchParams.set('paymentType', params.paymentType);
  }

  return searchParams.toString();
}

function formatEnumLabel(value: string) {
  return value
    .toLowerCase()
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function formatOrderAmount(amount: number, currency: string) {
  const formattedAmount = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);

  return `${formattedAmount} ${currency || 'ETB'}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString()}, ${date.toLocaleTimeString()}`;
}

function formatOrderItemAttributes(orderItem: MerchantOrderRow['orderItems'][number]) {
  const attributes = orderItem.optionSelections
    .map((selection) => {
      const groupName = selection.optionValue?.group?.name;
      const label = selection.optionValue?.label;

      if (!groupName || !label) {
        return null;
      }

      return `${groupName}: ${label}`;
    })
    .filter(Boolean);

  return attributes.length > 0 ? attributes.join(', ') : '—';
}

export default function MerchantOrdersPage() {
  useRequirePermission('merchants');
  const { toast } = useToast();
  const [orders, setOrders] = useState<MerchantOrderRow[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const deferredSearchInput = useDeferredValue(searchInput);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(ALL_FILTER_VALUE);
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<string>(ALL_FILTER_VALUE);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pagination, setPagination] = useState<PaginationState>(DEFAULT_PAGINATION);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [updatingAction, setUpdatingAction] = useState<'confirm' | 'cancel' | null>(null);
  const cacheRef = useRef(new Map<string, MerchantOrdersResponse>());
  const hasLoadedRef = useRef(false);

  const queryString = useMemo(
    () => buildOrdersQuery({
      page,
      pageSize,
      search: searchQuery,
      status: statusFilter,
      paymentType: paymentTypeFilter,
    }),
    [page, pageSize, paymentTypeFilter, searchQuery, statusFilter],
  );

  const hasActiveFilters = Boolean(
    searchInput.trim() || statusFilter !== ALL_FILTER_VALUE || paymentTypeFilter !== ALL_FILTER_VALUE,
  );

  const visibleRange = useMemo(() => {
    if (pagination.total === 0) {
      return { start: 0, end: 0 };
    }

    return {
      start: (pagination.page - 1) * pagination.pageSize + 1,
      end: Math.min(pagination.page * pagination.pageSize, pagination.total),
    };
  }, [pagination]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextSearch = deferredSearchInput.trim();

      startTransition(() => {
        setSearchQuery((currentValue) => (currentValue === nextSearch ? currentValue : nextSearch));
        setPage(1);
      });
    }, 350);

    return () => window.clearTimeout(timer);
  }, [deferredSearchInput]);

  useEffect(() => {
    const controller = new AbortController();
    const cachedResponse = cacheRef.current.get(queryString);

    const applyResponse = (response: MerchantOrdersResponse) => {
      startTransition(() => {
        setOrders(response.data);
        setPagination(response.pagination);
        setPage((currentPage) => (currentPage === response.pagination.page ? currentPage : response.pagination.page));
        setPageSize((currentPageSize) => (
          currentPageSize === response.pagination.pageSize ? currentPageSize : response.pagination.pageSize
        ));
      });
    };

    if (cachedResponse) {
      applyResponse(cachedResponse);
      hasLoadedRef.current = true;
      setIsLoading(false);
      setIsRefreshing(false);

      return () => controller.abort();
    }

    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    const fetchOrders = async () => {
      try {
        const response = await fetch(`/api/merchants/orders?${queryString}`, {
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(await extractErrorMessage(response, 'Failed to load merchant orders.'));
        }

        const data = (await response.json()) as MerchantOrdersResponse;

        if (controller.signal.aborted) {
          return;
        }

        cacheRef.current.set(queryString, data);
        cacheRef.current.set(
          buildOrdersQuery({
            page: data.pagination.page,
            pageSize: data.pagination.pageSize,
            search: searchQuery,
            status: statusFilter,
            paymentType: paymentTypeFilter,
          }),
          data,
        );

        applyResponse(data);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        toast({
          title: 'Error',
          description: error instanceof Error ? error.message : 'Failed to load merchant orders.',
          variant: 'destructive',
        });
      } finally {
        if (!controller.signal.aborted) {
          hasLoadedRef.current = true;
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    void fetchOrders();

    return () => controller.abort();
  }, [paymentTypeFilter, queryString, refreshToken, searchQuery, statusFilter, toast]);

  const invalidateOrderQueries = () => {
    cacheRef.current.clear();
    setRefreshToken((currentValue) => currentValue + 1);
  };

  const updateOrderStatus = async (
    orderId: string,
    nextStatus: 'ON_DELIVERY' | 'CANCELLED',
    cancelReason?: string,
  ) => {
    const currentAction = nextStatus === 'CANCELLED' ? 'cancel' : 'confirm';
    setUpdatingOrderId(orderId);
    setUpdatingAction(currentAction);

    try {
      const response = await fetch('/api/merchants/orders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: orderId,
          status: nextStatus,
          ...(cancelReason ? { cancelReason } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(
          await extractErrorMessage(
            response,
            nextStatus === 'CANCELLED' ? 'Failed to cancel order.' : 'Failed to update order.',
          ),
        );
      }

      toast({
        title: nextStatus === 'CANCELLED' ? 'Order cancelled' : 'Order updated',
        description: nextStatus === 'CANCELLED'
          ? 'The borrower will be notified that the order is cancelled.'
          : 'Order moved to On Delivery.',
      });

      if (nextStatus === 'CANCELLED') {
        setCancelOrderId(null);
      }

      invalidateOrderQueries();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Unable to update order status.',
        variant: 'destructive',
      });
    } finally {
      setUpdatingOrderId(null);
      setUpdatingAction(null);
    }
  };

  const clearFilters = () => {
    startTransition(() => {
      setSearchInput('');
      setSearchQuery('');
      setStatusFilter(ALL_FILTER_VALUE);
      setPaymentTypeFilter(ALL_FILTER_VALUE);
      setPage(1);
    });
  };

  return (
    <div className="flex-1 space-y-4 p-8 pt-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Orders</h2>
          <p className="text-muted-foreground">Manage merchant orders with server-side filtering, search, and pagination.</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {isRefreshing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Refreshing results</span>
            </>
          ) : (
            <span>{pagination.total} total orders</span>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-xs text-muted-foreground">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by order ID, borrower ID, merchant, or item"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="pl-9"
                />
              </div>
            </div>

            <div className="w-full sm:w-[220px]">
              <label className="mb-1 block text-xs text-muted-foreground">Status</label>
              <Select
                value={statusFilter}
                onValueChange={(value) => {
                  startTransition(() => {
                    setStatusFilter(value);
                    setPage(1);
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTER_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === ALL_FILTER_VALUE ? 'All statuses' : formatEnumLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-full sm:w-[180px]">
              <label className="mb-1 block text-xs text-muted-foreground">Payment Type</label>
              <Select
                value={paymentTypeFilter}
                onValueChange={(value) => {
                  startTransition(() => {
                    setPaymentTypeFilter(value);
                    setPage(1);
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === ALL_FILTER_VALUE ? 'All types' : option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-full sm:w-[140px]">
              <label className="mb-1 block text-xs text-muted-foreground">Rows per page</label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  startTransition(() => {
                    setPageSize(Number.parseInt(value, 10));
                    setPage(1);
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="h-10 gap-1 self-start xl:self-auto">
                <X className="h-4 w-4" />
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Order Queue</CardTitle>
          <CardDescription>
            {pagination.total === 0
              ? 'No orders match the current filters.'
              : `Showing ${visibleRange.start} to ${visibleRange.end} of ${pagination.total} orders.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Order Date</TableHead>
                  <TableHead>Item(s)</TableHead>
                  <TableHead>Attributes</TableHead>
                  <TableHead>Borrower</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-32 text-center">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : orders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                      {hasActiveFilters ? 'No orders match the current filters.' : 'No orders yet.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  orders.map((order) => {
                    const isConfirming = updatingOrderId === order.id && updatingAction === 'confirm';
                    const actionDisabled = Boolean(updatingOrderId);
                    const canConfirm = !['ON_DELIVERY', 'DELIVERED', 'CANCELLED'].includes(order.status);
                    const canCancel = !['DELIVERED', 'CANCELLED'].includes(order.status);

                    return (
                      <TableRow key={order.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{order.id}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{formatDateTime(order.createdAt)}</TableCell>
                        <TableCell>
                          {order.orderItems.map((orderItem) => (
                            <div key={orderItem.id} className="text-sm">
                              {orderItem.item?.name || 'Unnamed item'}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell>
                          {order.orderItems.map((orderItem) => (
                            <div key={orderItem.id} className="text-sm text-muted-foreground">
                              {formatOrderItemAttributes(orderItem)}
                            </div>
                          ))}
                        </TableCell>
                        <TableCell className="text-sm">{order.borrowerId}</TableCell>
                        <TableCell className="text-sm">{order.merchant?.name || '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm font-medium">
                          {formatOrderAmount(order.totalAmount, order.currency)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className={order.paymentType === 'DIRECT'
                              ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                              : 'bg-amber-100 text-amber-800 border-amber-300'}
                            variant="outline"
                          >
                            {order.paymentType === 'DIRECT' ? 'Direct' : 'BNPL'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={statusColor[order.status] || ''} variant="outline">
                            {formatEnumLabel(order.status)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void updateOrderStatus(order.id, 'ON_DELIVERY')}
                              className="whitespace-nowrap"
                              disabled={actionDisabled || !canConfirm}
                            >
                              {isConfirming ? (
                                <span className="inline-flex items-center gap-2">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Updating
                                </span>
                              ) : (
                                'Confirm availability'
                              )}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setCancelOrderId(order.id)}
                              className="whitespace-nowrap border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                              disabled={actionDisabled || !canCancel}
                            >
                              Cancel
                            </Button>
                          </div>
                          {order.status === 'CANCELLED' && order.cancelReason && (
                            <p className="mt-1 text-xs text-red-500">Reason: {order.cancelReason}</p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {pagination.total === 0
              ? 'No results to display.'
              : `Showing ${visibleRange.start} to ${visibleRange.end} of ${pagination.total} orders.`}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
              disabled={!pagination.hasPreviousPage || isLoading || isRefreshing}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((currentPage) => Math.min(pagination.totalPages, currentPage + 1))}
              disabled={!pagination.hasNextPage || isLoading || isRefreshing}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardFooter>
      </Card>

      {cancelOrderId ? (
        <MerchantOrderCancelDialog
          open={Boolean(cancelOrderId)}
          orderId={cancelOrderId}
          isSubmitting={updatingOrderId === cancelOrderId && updatingAction === 'cancel'}
          onOpenChange={(open: boolean) => {
            if (!open && updatingAction !== 'cancel') {
              setCancelOrderId(null);
            }
          }}
          onConfirm={(reason: string) => void updateOrderStatus(cancelOrderId, 'CANCELLED', reason)}
        />
      ) : null}
    </div>
  );
}