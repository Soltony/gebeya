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
    const locationId = searchParams.get('locationId');
    const where: any = {};
    if (itemId) where.itemId = itemId;
    if (locationId) where.stockLocationId = locationId;

    const levels = await prisma.inventoryLevel.findMany({
      where,
      include: { item: { select: { id: true, name: true, merchantId: true, merchant: { select: { name: true } } } }, stockLocation: true },
      orderBy: { updatedAt: 'desc' },
    });

    const comboWhere: any = {};
    if (itemId) comboWhere.itemId = itemId;
    if (locationId) comboWhere.locationId = locationId;

    const combinationLevels = await prisma.combinationInventoryLevel.findMany({
      where: comboWhere,
      include: { item: { select: { id: true, name: true } }, location: true },
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json({ levels, combinationLevels });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getUserFromSession();
  if (!user || !(user.permissions?.['merchants']?.create || user.permissions?.['branch']?.create)) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  try {
    const body = await req.json();

    // Bulk upsert for combination inventory levels
    if (body.bulkCombinations && Array.isArray(body.bulkCombinations)) {
      const { itemId, bulkCombinations } = body;
      if (!itemId) {
        return NextResponse.json({ error: 'itemId is required for bulk combination inventory' }, { status: 400 });
      }

      // Delete existing combination inventory for this item, then recreate
      await prisma.combinationInventoryLevel.deleteMany({ where: { itemId } });

      const created = [];
      for (const combo of bulkCombinations) {
        const { locationId, combinationKey, optionValueIds, quantityAvailable } = combo;
        if (!locationId || !combinationKey) continue;

        const level = await prisma.combinationInventoryLevel.create({
          data: {
            itemId,
            locationId,
            combinationKey,
            optionValueIds: JSON.stringify(optionValueIds || []),
            quantityAvailable: parseInt(quantityAvailable || '0'),
          },
        });
        created.push(level);
      }

      await createAuditLog({
        actorId: user.id,
        action: 'BULK_UPSERT_COMBINATION_INVENTORY',
        entity: 'CombinationInventoryLevel',
        details: JSON.stringify({ itemId, count: created.length }),
      });
      return NextResponse.json(created, { status: 201 });
    }

    // Single combination inventory upsert
    const { itemId, stockLocationId, quantity, combinationKey, optionValueIds } = body;

    if (combinationKey && itemId && stockLocationId) {
      const level = await prisma.combinationInventoryLevel.upsert({
        where: {
          itemId_locationId_combinationKey: {
            itemId,
            locationId: stockLocationId,
            combinationKey,
          },
        },
        update: { quantityAvailable: parseInt(quantity || '0') },
        create: {
          itemId,
          locationId: stockLocationId,
          combinationKey,
          optionValueIds: JSON.stringify(optionValueIds || []),
          quantityAvailable: parseInt(quantity || '0'),
        },
      });
      await createAuditLog({ actorId: user.id, action: 'UPSERT_COMBINATION_INVENTORY', entity: 'CombinationInventoryLevel', entityId: level.id });
      return NextResponse.json(level, { status: 201 });
    }

    if (!itemId || !stockLocationId) {
      return NextResponse.json({ error: 'itemId and stockLocationId are required' }, { status: 400 });
    }

    const level = await prisma.inventoryLevel.upsert({
      where: { itemId_stockLocationId: { itemId, stockLocationId } },
      update: { quantity: parseInt(quantity || '0') },
      create: { itemId, stockLocationId, quantity: parseInt(quantity || '0') },
    });

    await createAuditLog({ actorId: user.id, action: 'UPSERT_INVENTORY', entity: 'InventoryLevel', entityId: level.id, details: JSON.stringify({ itemId, stockLocationId, quantity }) });
    return NextResponse.json(level, { status: 201 });
  } catch (error) {
    console.error('Error updating inventory:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
