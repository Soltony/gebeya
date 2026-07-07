import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';

export async function GET() {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const where: any = {};
    // Merchant users only see their own discount rules
    if (user.merchantId) where.merchantId = user.merchantId;

    const rules = await prisma.discountRule.findMany({
      where,
      include: { item: { select: { id: true, name: true } }, category: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(rules);
  } catch (error) {
    console.error('Error fetching discount rules:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['merchants']?.create) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { name, type, value, buyX, getY, itemId, categoryId, minQuantity, startDate, endDate, status } = body;
    if (!name || !type) return NextResponse.json({ error: 'Name and type are required' }, { status: 400 });

    // Auto-set merchantId for merchant users
    const merchantId = user.merchantId || null;

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantDiscountRule',
        changeType: 'CREATE',
        payload: JSON.stringify({
          created: {
            name,
            type,
            value: parseFloat(value || '0'),
            buyX: buyX ? parseInt(buyX) : null,
            getY: getY ? parseInt(getY) : null,
            merchantId,
            itemId: itemId || null,
            categoryId: categoryId || null,
            minQuantity: minQuantity ? parseInt(minQuantity) : 1,
            startDate: startDate || null,
            endDate: endDate || null,
            status: status || 'ACTIVE',
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'CREATE_DISCOUNT_RULE_REQUEST', entity: 'DiscountRule', details: JSON.stringify({ name, type }) });
    return NextResponse.json(pending, { status: 201 });
  } catch (error) {
    console.error('Error creating discount rule request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['merchants']?.update) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { id, name, type, value, buyX, getY, itemId, categoryId, minQuantity, startDate, endDate, status } = body;
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.discountRule.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Discount rule not found' }, { status: 404 });

    // Merchant users can only update their own discount rules
    if (user.merchantId && existing.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantDiscountRule',
        entityId: id,
        changeType: 'UPDATE',
        payload: JSON.stringify({
          original: existing,
          updated: {
            name: name || existing.name,
            type: type || existing.type,
            value: value != null ? parseFloat(value) : existing.value,
            buyX: buyX !== undefined ? (buyX ? parseInt(buyX) : null) : existing.buyX,
            getY: getY !== undefined ? (getY ? parseInt(getY) : null) : existing.getY,
            itemId: itemId !== undefined ? (itemId || null) : existing.itemId,
            categoryId: categoryId !== undefined ? (categoryId || null) : existing.categoryId,
            minQuantity: minQuantity != null ? parseInt(minQuantity) : existing.minQuantity,
            startDate: startDate !== undefined ? (startDate || null) : existing.startDate,
            endDate: endDate !== undefined ? (endDate || null) : existing.endDate,
            status: status || existing.status,
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'UPDATE_DISCOUNT_RULE_REQUEST', entity: 'DiscountRule', entityId: id });
    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error updating discount rule request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['merchants']?.delete) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    let id = searchParams.get('id');
    if (!id) {
      try { const body = await req.json(); id = body.id; } catch { /* ignore */ }
    }
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.discountRule.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Discount rule not found' }, { status: 404 });

    // Merchant users can only delete their own discount rules
    if (user.merchantId && existing.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantDiscountRule',
        entityId: id,
        changeType: 'DELETE',
        payload: JSON.stringify({ original: existing }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'DELETE_DISCOUNT_RULE_REQUEST', entity: 'DiscountRule', entityId: id });
    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error deleting discount rule request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
