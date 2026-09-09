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

/**
 * Parses a price coming from a JSON body into a finite number.
 * Returns null for empty strings and non-numeric values so an invalid price is
 * never parsed to NaN - NaN serialises to `null` in the pending-change payload
 * and later breaks `prisma.item.update` (price is a required Float).
 */
function parsePrice(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const { searchParams } = new URL(req.url);
    const merchantId = searchParams.get('merchantId');
    // DELETED items are kept only so past orders still resolve what was sold.
    const where: any = { status: { not: 'DELETED' } };
    if (merchantId) where.merchantId = merchantId;
    // If user is a merchant user, scope to their merchant
    if (user.merchantId) where.merchantId = user.merchantId;

    const items = await prisma.item.findMany({
      where,
      include: {
        merchant: true,
        category: true,
        variants: true,
        optionGroups: {
          where: { status: 'ACTIVE' },
          include: { values: { where: { status: 'ACTIVE' } } },
        },
      },
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
    let { merchantId, categoryId, name, description, price, imageUrl, videoUrl, status, sellingOption, requiresMerchantAvailabilityConfirmation, variants, optionGroups } = body;

    // Merchant users can only create items for their own merchant
    if (user.merchantId) merchantId = user.merchantId;

    const parsedPrice = parsePrice(price);
    if (!merchantId || !categoryId || !name || parsedPrice == null) {
      return NextResponse.json({ error: 'merchantId, categoryId, name, and a valid price are required' }, { status: 400 });
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
            price: parsedPrice,
            imageUrl: imageUrl || null,
            videoUrl: videoUrl || null,
            status: status || 'ACTIVE',
            sellingOption: sellingOption || 'BNPL_ONLY',
            // Defaults to true (matching the column default) when the caller omits it.
            requiresMerchantAvailabilityConfirmation:
              requiresMerchantAvailabilityConfirmation === undefined ? true : !!requiresMerchantAvailabilityConfirmation,
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
    const { id, merchantId, categoryId, name, description, price, imageUrl, videoUrl, status, sellingOption, requiresMerchantAvailabilityConfirmation, variants, optionGroups } = body;
    if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

    // Reject an invalid price up front instead of storing NaN (serialised as
    // null) in the pending-change payload.
    const parsedPrice = parsePrice(price);
    if (price !== undefined && price !== null && parsedPrice == null) {
      return NextResponse.json({ error: 'Price must be a valid number' }, { status: 400 });
    }

    const existing = await prisma.item.findUnique({
      where: { id },
      include: {
        merchant: true,
        category: true,
        variants: true,
        optionGroups: {
          where: { status: 'ACTIVE' },
          include: { values: { where: { status: 'ACTIVE' } } },
        },
      },
    });
    // A DELETED item is gone as far as the admin is concerned; it survives
    // only to keep past orders readable.
    if (!existing || existing.status === 'DELETED') {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

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
            price: parsedPrice ?? existing.price,
            imageUrl: imageUrl ?? existing.imageUrl,
            videoUrl: videoUrl ?? existing.videoUrl,
            status: status || existing.status,
            sellingOption: sellingOption || existing.sellingOption,
            requiresMerchantAvailabilityConfirmation:
              requiresMerchantAvailabilityConfirmation !== undefined
                ? !!requiresMerchantAvailabilityConfirmation
                : existing.requiresMerchantAvailabilityConfirmation,
            // Omit these when the caller did not send them. JSON.stringify
            // drops the undefined keys, and the approval step reads an absent
            // key as "leave alone". Defaulting to [] instead would wipe every
            // variant and option group of an item whenever a form that does
            // not manage them is saved.
            variants: variants ?? undefined,
            optionGroups: optionGroups ?? undefined,
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
    // A DELETED item is gone as far as the admin is concerned; it survives
    // only to keep past orders readable.
    if (!existing || existing.status === 'DELETED') {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    }

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
