import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { startOfDay, endOfDay, subDays, format } from 'date-fns';

export async function GET() {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const merchantId = user.merchantId;
  if (!merchantId) {
    // User has merchant role but no merchant assigned - return empty dashboard
    return NextResponse.json({
      totalOrders: 0,
      totalRevenue: 0,
      todaysOrders: 0,
      todaysRevenue: 0,
      pendingOrders: 0,
      deliveredOrders: 0,
      totalItems: 0,
      activeItems: 0,
      revenueByDay: [],
      topItems: [],
      recentOrders: [],
      ordersByStatus: { pending: 0, confirmed: 0, delivered: 0, cancelled: 0 },
      paymentTypeBreakdown: { bnpl: 0, direct: 0 },
    });
  }

  try {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    // Fetch all orders for this merchant
    const orders = await prisma.order.findMany({
      where: { merchantId },
      include: {
        orderItems: { include: { item: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const totalOrders = orders.length;
    const confirmedOrders = orders.filter(o => o.status === 'DELIVERED' || o.status === 'ON_DELIVERY' || o.status === 'CONFIRMED').length;
    const pendingOrders = orders.filter(o => o.status === 'PENDING_MERCHANT_CONFIRMATION').length;
    const cancelledOrders = orders.filter(o => o.status === 'CANCELLED').length;
    const deliveredOrders = orders.filter(o => o.status === 'DELIVERED').length;

    // Total revenue (from delivered orders)
    const totalRevenue = orders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    // Today's orders
    const todaysOrders = orders.filter(o => {
      const d = new Date(o.createdAt);
      return d >= todayStart && d <= todayEnd;
    });
    const todaysRevenue = todaysOrders
      .filter(o => o.status === 'DELIVERED')
      .reduce((sum, o) => sum + o.totalAmount, 0);

    // Revenue over last 30 days for chart
    const revenueByDay: { date: string; revenue: number; orders: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const day = subDays(now, i);
      const dayStart = startOfDay(day);
      const dayEnd = endOfDay(day);
      const dayOrders = orders.filter(o => {
        const d = new Date(o.createdAt);
        return d >= dayStart && d <= dayEnd;
      });
      revenueByDay.push({
        date: format(day, 'MMM dd'),
        revenue: dayOrders
          .filter(o => o.status === 'DELIVERED')
          .reduce((sum, o) => sum + o.totalAmount, 0),
        orders: dayOrders.length,
      });
    }

    // Top selling items
    const itemSales: Record<string, { name: string; quantity: number; revenue: number }> = {};
    for (const order of orders.filter(o => o.status === 'DELIVERED')) {
      for (const oi of order.orderItems) {
        const key = oi.itemId;
        if (!itemSales[key]) {
          itemSales[key] = { name: oi.item?.name || 'Unknown', quantity: 0, revenue: 0 };
        }
        itemSales[key].quantity += oi.quantity;
        itemSales[key].revenue += oi.lineTotal;
      }
    }
    const topItems = Object.values(itemSales)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Items count
    const totalItems = await prisma.item.count({ where: { merchantId } });
    const activeItems = await prisma.item.count({ where: { merchantId, status: 'ACTIVE' } });

    // Recent orders (last 10)
    const recentOrders = orders.slice(0, 10).map(o => ({
      id: o.id,
      status: o.status,
      totalAmount: o.totalAmount,
      paymentType: o.paymentType,
      itemCount: o.orderItems.length,
      createdAt: o.createdAt,
    }));

    // Order status breakdown
    const ordersByStatus = {
      pending: pendingOrders,
      confirmed: confirmedOrders,
      delivered: deliveredOrders,
      cancelled: cancelledOrders,
    };

    // Payment type breakdown
    const bnplOrders = orders.filter(o => o.paymentType === 'BNPL').length;
    const directOrders = orders.filter(o => o.paymentType === 'DIRECT').length;

    return NextResponse.json({
      totalOrders,
      totalRevenue,
      todaysOrders: todaysOrders.length,
      todaysRevenue,
      pendingOrders,
      deliveredOrders,
      totalItems,
      activeItems,
      revenueByDay,
      topItems,
      recentOrders,
      ordersByStatus,
      paymentTypeBreakdown: { bnpl: bnplOrders, direct: directOrders },
    });
  } catch (error) {
    console.error('Error fetching merchant dashboard:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
