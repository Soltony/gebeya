import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const { searchParams } = new URL(req.url);
    const itemId = searchParams.get('itemId');
    const where: any = {};
    if (itemId) where.itemId = itemId;

    const variants = await prisma.itemVariant.findMany({
      where,
      include: { item: { select: { id: true, name: true, merchantId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(variants);
  } catch (error) {
    console.error('Error fetching variants:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['merchants']?.create) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { itemId, name, size, color, material, price, status } = await req.json();
    if (!itemId || !name || price == null) {
      return NextResponse.json({ error: 'itemId, name, and price are required' }, { status: 400 });
    }

    const variant = await prisma.itemVariant.create({
      data: { itemId, name, size: size || null, color: color || null, material: material || null, price: parseFloat(price), status: status || 'ACTIVE' },
    });

    await createAuditLog({ actorId: user.id, action: 'CREATE_ITEM_VARIANT', entity: 'ItemVariant', entityId: variant.id, details: JSON.stringify({ itemId, name }) });
    return NextResponse.json(variant, { status: 201 });
  } catch (error) {
    console.error('Error creating variant:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !user.permissions?.['merchants']?.update) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const { id, name, size, color, material, price, status } = await req.json();
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const updated = await prisma.itemVariant.update({
      where: { id },
      data: {
        ...(name && { name }),
        size: size ?? undefined,
        color: color ?? undefined,
        material: material ?? undefined,
        ...(price != null && { price: parseFloat(price) }),
        ...(status && { status }),
      },
    });

    await createAuditLog({ actorId: user.id, action: 'UPDATE_ITEM_VARIANT', entity: 'ItemVariant', entityId: id });
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Error updating variant:', error);
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
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    await prisma.itemVariant.delete({ where: { id } });
    await createAuditLog({ actorId: user.id, action: 'DELETE_ITEM_VARIANT', entity: 'ItemVariant', entityId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting variant:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
