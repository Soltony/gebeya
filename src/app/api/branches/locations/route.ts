import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { hasPermissionForEntity } from '@/lib/permissions';

export async function GET() {
  const user = await getUserFromSession();
  if (!user || !hasPermissionForEntity(user, 'StockLocation', 'read')) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const where: any = {};
    // Merchant users only see their own locations
    if (user.merchantId) where.merchantId = user.merchantId;

    const locations = await prisma.stockLocation.findMany({
      where,
      include: { branch: true },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(locations);
  } catch (error) {
    console.error('Error fetching locations:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !hasPermissionForEntity(user, 'StockLocation', 'create')) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { name, address, contactInfo, branchId, status } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    // Auto-set merchantId for merchant users
    const merchantId = user.merchantId || null;

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantLocation',
        changeType: 'CREATE',
        payload: JSON.stringify({
          created: {
            name: name.trim(),
            address: address || null,
            contactInfo: contactInfo || null,
            branchId: branchId || null,
            merchantId,
            status: status || 'ACTIVE',
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'CREATE_STOCK_LOCATION_REQUEST', entity: 'StockLocation', details: JSON.stringify({ name }) });
    return NextResponse.json(pending, { status: 201 });
  } catch (error) {
    console.error('Error creating location request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !hasPermissionForEntity(user, 'StockLocation', 'update')) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { id, name, address, contactInfo, branchId, status } = await req.json();
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.stockLocation.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Location not found' }, { status: 404 });

    // Merchant users can only update their own locations
    if (user.merchantId && existing.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantLocation',
        entityId: id,
        changeType: 'UPDATE',
        payload: JSON.stringify({
          original: existing,
          updated: {
            name: name || existing.name,
            address: address ?? existing.address,
            contactInfo: contactInfo ?? existing.contactInfo,
            branchId: branchId !== undefined ? (branchId || null) : existing.branchId,
            status: status || existing.status,
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'UPDATE_STOCK_LOCATION_REQUEST', entity: 'StockLocation', entityId: id });
    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error updating location request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !hasPermissionForEntity(user, 'StockLocation', 'delete')) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.stockLocation.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Location not found' }, { status: 404 });

    // Merchant users can only delete their own locations
    if (user.merchantId && existing.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantLocation',
        entityId: id,
        changeType: 'DELETE',
        payload: JSON.stringify({ original: existing }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'DELETE_STOCK_LOCATION_REQUEST', entity: 'StockLocation', entityId: id });
    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error deleting location request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
