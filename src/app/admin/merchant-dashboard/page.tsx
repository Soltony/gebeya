'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useRequirePermission } from '@/hooks/use-require-permission';
import {
  ShoppingBag,
  DollarSign,
  Package,
  Clock,
  TrendingUp,
  Truck,
  Ban,
  BarChart3,
} from 'lucide-react';

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + ' ETB';

const statusColors: Record<string, string> = {
  PENDING_MERCHANT_CONFIRMATION: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  ON_DELIVERY: 'bg-blue-100 text-blue-800 border-blue-300',
  CONFIRMED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  DELIVERED: 'bg-green-100 text-green-800 border-green-300',
  CANCELLED: 'bg-red-100 text-red-800 border-red-300',
};

const statusLabels: Record<string, string> = {
  PENDING_MERCHANT_CONFIRMATION: 'Pending',
  ON_DELIVERY: 'On Delivery',
  CONFIRMED: 'Confirmed',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

interface DashboardData {
  totalOrders: number;
  totalRevenue: number;
  todaysOrders: number;
  todaysRevenue: number;
  pendingOrders: number;
  deliveredOrders: number;
  totalItems: number;
  activeItems: number;
  revenueByDay: { date: string; revenue: number; orders: number }[];
  topItems: { name: string; quantity: number; revenue: number }[];
  recentOrders: { id: string; status: string; totalAmount: number; paymentType: string; itemCount: number; createdAt: string }[];
  ordersByStatus: { pending: number; confirmed: number; delivered: number; cancelled: number };
  paymentTypeBreakdown: { bnpl: number; direct: number };
}

export default function MerchantDashboardPage() {
  useRequirePermission('merchants');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/merchants/dashboard');
      if (res.ok) {
        setData(await res.json());
      } else {
        console.error('Dashboard API error:', res.status, await res.text());
      }
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Loading dashboard...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex-1 space-y-4 p-8 pt-6">
        <h2 className="text-3xl font-bold tracking-tight">Merchant Dashboard</h2>
        <p className="text-muted-foreground">Unable to load dashboard data.</p>
      </div>
    );
  }

  const maxRevenue = Math.max(...data.revenueByDay.map(d => d.revenue), 1);

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Merchant Dashboard</h2>
        <p className="text-muted-foreground">Overview of your store performance and sales.</p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(data.totalRevenue)}</div>
            <p className="text-xs text-muted-foreground">From {data.deliveredOrders} delivered orders</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Orders</CardTitle>
            <ShoppingBag className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.totalOrders}</div>
            <p className="text-xs text-muted-foreground">{data.todaysOrders} today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Orders</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.pendingOrders}</div>
            <p className="text-xs text-muted-foreground">Awaiting confirmation</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Items</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.activeItems}</div>
            <p className="text-xs text-muted-foreground">{data.totalItems} total items</p>
          </CardContent>
        </Card>
      </div>

      {/* Today's Snapshot + Payment Type */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today&apos;s Revenue</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(data.todaysRevenue)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Order Status</CardTitle>
            <Truck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-300">Pending: {data.ordersByStatus.pending}</Badge>
              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300">Delivered: {data.ordersByStatus.delivered}</Badge>
              <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300">Cancelled: {data.ordersByStatus.cancelled}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Payment Types</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300">BNPL: {data.paymentTypeBreakdown.bnpl}</Badge>
              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300">Direct: {data.paymentTypeBreakdown.direct}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Revenue Chart (simple bar) */}
      <Card>
        <CardHeader>
          <CardTitle>Revenue (Last 30 Days)</CardTitle>
          <CardDescription>Daily revenue from delivered orders</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-[2px] h-40">
            {data.revenueByDay.map((day, i) => (
              <div
                key={i}
                className="flex-1 group relative"
              >
                <div
                  className="bg-amber-500 hover:bg-amber-600 rounded-t-sm transition-colors w-full"
                  style={{ height: `${Math.max((day.revenue / maxRevenue) * 100, 2)}%` }}
                />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-popover border rounded px-2 py-1 text-xs shadow-md whitespace-nowrap z-10">
                  <div className="font-medium">{day.date}</div>
                  <div>{formatCurrency(day.revenue)}</div>
                  <div>{day.orders} orders</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>{data.revenueByDay[0]?.date}</span>
            <span>{data.revenueByDay[data.revenueByDay.length - 1]?.date}</span>
          </div>
        </CardContent>
      </Card>

      {/* Top Items + Recent Orders */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Top Selling Items */}
        <Card>
          <CardHeader>
            <CardTitle>Top Selling Items</CardTitle>
            <CardDescription>By revenue from delivered orders</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty Sold</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topItems.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{item.name}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">{formatCurrency(item.revenue)}</TableCell>
                  </TableRow>
                ))}
                {data.topItems.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground py-4">No sales data yet.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Recent Orders */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Orders</CardTitle>
            <CardDescription>Last 10 orders received</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentOrders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium text-xs">{order.id.slice(0, 8)}...</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusColors[order.status] || ''}>
                        {statusLabels[order.status] || order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={order.paymentType === 'BNPL' ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-blue-50 text-blue-700 border-blue-300'}>
                        {order.paymentType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{formatCurrency(order.totalAmount)}</TableCell>
                  </TableRow>
                ))}
                {data.recentOrders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-4">No orders yet.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
