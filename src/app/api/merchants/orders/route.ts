import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePositiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const { searchParams } = new URL(req.url);
    const merchantId = searchParams.get('merchantId');
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, parsePositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE));
    const search = searchParams.get('search')?.trim() || '';
    const status = searchParams.get('status')?.trim() || '';
    const paymentType = searchParams.get('paymentType')?.trim() || '';

    const where: Prisma.OrderWhereInput = {};

    if (merchantId) where.merchantId = merchantId;
    if (user.merchantId) where.merchantId = user.merchantId;

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (paymentType && paymentType !== 'ALL') {
      where.paymentType = paymentType;
    }

    if (search) {
      where.OR = [
        { id: { contains: search } },
        { borrowerId: { contains: search } },
        { merchant: { name: { contains: search } } },
        {
          orderItems: {
            some: {
              item: {
                name: { contains: search },
              },
            },
          },
        },
      ];
    }

    const total = await prisma.order.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);

    const orders = total === 0
      ? []
      : await prisma.order.findMany({
        where,
        select: {
          id: true,
          borrowerId: true,
          totalAmount: true,
          currency: true,
          paymentType: true,
          status: true,
          cancelReason: true,
          createdAt: true,
          merchant: {
            select: {
              id: true,
              name: true,
            },
          },
          orderItems: {
            select: {
              id: true,
              item: {
                select: {
                  name: true,
                },
              },
              optionSelections: {
                select: {
                  id: true,
                  optionValue: {
                    select: {
                      label: true,
                      group: {
                        select: {
                          name: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * pageSize,
        take: pageSize,
      });

    return NextResponse.json({
      data: orders,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPreviousPage: safePage > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['orders']?.update) {
    // Also allow merchants to update their orders
    if (!user?.permissions?.['merchants']?.update) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
  }

  try {
    const { id, status, cancelReason } = await req.json();
    if (!id || !status) return NextResponse.json({ error: 'ID and status are required' }, { status: 400 });

    const validStatuses = ['PENDING_MERCHANT_CONFIRMATION', 'ON_DELIVERY', 'DELIVERED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

    // Merchant users can only update their own orders
    if (user.merchantId && order.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Prevent cancelling delivered orders
    if (status === 'CANCELLED' && order.status === 'DELIVERED') {
      return NextResponse.json({ error: 'Cannot cancel a delivered order' }, { status: 400 });
    }

    const updateData: any = { status };
    if (status === 'CANCELLED') {
      updateData.cancelReason = cancelReason || 'Item not available';
      updateData.cancelledBy = 'MERCHANT';
    }

    const updated = await prisma.order.update({
      where: { id },
      data: updateData,
      include: { merchant: true, orderItems: { include: { item: true } } },
    });

    // If cancelling, also cancel the linked loan application
    if (status === 'CANCELLED' && order.loanApplicationId) {
      await prisma.loanApplication.update({
        where: { id: order.loanApplicationId },
        data: { status: 'CANCELLED' },
      }).catch(() => {});
    }

    await createAuditLog({ actorId: user.id, action: 'UPDATE_ORDER_STATUS', entity: 'Order', entityId: id, details: JSON.stringify({ status, cancelReason }) });
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating order:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
