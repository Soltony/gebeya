import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { createAuditLog } from '@/lib/audit-log';
import { validateImageField } from '@/lib/validators';

function normalizeOptionGroups(groups: any[]): Array<{ name: string; values: Array<{ label: string; priceDelta: number }> }> {
  return (groups || [])
    .map((g: any) => ({
      name: String(g?.name || '').trim(),
      values: (g?.values || [])
        .map((v: any) => ({
          label: String(v?.label || '').trim(),
          priceDelta: Number.parseFloat(String(v?.priceDelta ?? 0)) || 0,
        }))
        .filter((v: any) => v.label)
        .sort((a: any, b: any) => a.label.localeCompare(b.label)),
    }))
    .filter((g: any) => g.name)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
}

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const { searchParams } = new URL(req.url);
    const merchantId = searchParams.get('merchantId');
    const where: any = {};
    if (merchantId) where.merchantId = merchantId;
    // If user is a merchant user, scope to their merchant
    if (user.merchantId) where.merchantId = user.merchantId;

    const items = await prisma.item.findMany({
      where,
      include: { merchant: true, category: true, variants: true, optionGroups: { include: { values: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json(items);
  } catch (error) {
    console.error('Error fetching items:', error);
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
    let { merchantId, categoryId, name, description, price, imageUrl, videoUrl, status, sellingOption, variants, optionGroups } = body;

    // Merchant users can only create items for their own merchant
    if (user.merchantId) merchantId = user.merchantId;

    if (!merchantId || !categoryId || !name || price == null) {
      return NextResponse.json({ error: 'merchantId, categoryId, name, and price are required' }, { status: 400 });
    }

    // Validate image(s) if provided
    const imageError = validateImageField(imageUrl, 'Image');
    if (imageError) return NextResponse.json({ error: imageError }, { status: 400 });

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantItem',
        changeType: 'CREATE',
        payload: JSON.stringify({
          created: {
            merchantId,
            categoryId,
            name,
            description: description || null,
            price: parseFloat(price),
            imageUrl: imageUrl || null,
            videoUrl: videoUrl || null,
            status: status || 'ACTIVE',
            sellingOption: sellingOption || 'BNPL_ONLY',
            variants: variants || [],
            optionGroups: optionGroups || [],
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'CREATE_ITEM_REQUEST', entity: 'Item', details: JSON.stringify({ name, merchantId }) });
    return NextResponse.json(pending, { status: 201 });
  } catch (error) {
    console.error('Error creating item request:', error);
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
    const { id, merchantId, categoryId, name, description, price, imageUrl, videoUrl, status, sellingOption, variants, optionGroups } = body;
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    const existing = await prisma.item.findUnique({
      where: { id },
      include: { merchant: true, category: true, variants: true, optionGroups: { include: { values: true } } },
    });
    if (!existing) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

    // Merchant users can only update their own items
    if (user.merchantId && existing.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Validate image(s) if a new value is provided
    if (imageUrl !== undefined && imageUrl) {
      const imageError = validateImageField(imageUrl, 'Image');
      if (imageError) return NextResponse.json({ error: imageError }, { status: 400 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantItem',
        entityId: id,
        changeType: 'UPDATE',
        payload: JSON.stringify({
          original: existing,
          updated: {
            merchantId: merchantId || existing.merchantId,
            categoryId: categoryId || existing.categoryId,
            name: name || existing.name,
            description: description ?? existing.description,
            price: price != null ? parseFloat(price) : existing.price,
            imageUrl: imageUrl ?? existing.imageUrl,
            videoUrl: videoUrl ?? existing.videoUrl,
            status: status || existing.status,
            sellingOption: sellingOption || existing.sellingOption,
            variants: variants || [],
            optionGroups: optionGroups || [],
          },
        }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'UPDATE_ITEM_REQUEST', entity: 'Item', entityId: id, details: JSON.stringify({ name }) });
    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error updating item request:', error);
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

    const existing = await prisma.item.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

    // Merchant users can only delete their own items
    if (user.merchantId && existing.merchantId !== user.merchantId) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const pending = await prisma.pendingChange.create({
      data: {
        entityType: 'MerchantItem',
        entityId: id,
        changeType: 'DELETE',
        payload: JSON.stringify({ original: existing }),
        createdById: user.id,
      },
    });

    await createAuditLog({ actorId: user.id, action: 'DELETE_ITEM_REQUEST', entity: 'Item', entityId: id });
    return NextResponse.json(pending);
  } catch (error) {
    console.error('Error deleting item request:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
