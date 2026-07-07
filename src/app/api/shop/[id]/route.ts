import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isDiscountActive, pickBestDiscount } from '@/lib/discount-utils';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const item = await prisma.item.findUnique({
      where: { id, status: 'ACTIVE' },
      include: {
        merchant: { select: { id: true, name: true, status: true, bnplEnabled: true } },
        category: { select: { id: true, name: true } },
        variants: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } },
        optionGroups: { include: { values: true }, orderBy: { createdAt: 'asc' } },
        discountRules: { where: { status: 'ACTIVE' } },
      },
    });

    if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

    const now = new Date();
    const itemDiscounts = item.discountRules.filter(r => isDiscountActive(r, now) && (!r.merchantId || r.merchantId === item.merchantId));

    // Also fetch category-level discounts
    let catDiscounts: any[] = [];
    if (item.categoryId) {
      catDiscounts = await prisma.discountRule.findMany({
        where: {
          status: 'ACTIVE',
          categoryId: item.categoryId,
          itemId: null,
          OR: [{ merchantId: item.merchantId }, { merchantId: null }],
        },
      });
    }

    const allDiscounts = [...itemDiscounts, ...catDiscounts.filter(r => isDiscountActive(r, now))];

    const selectedDiscount = pickBestDiscount(Number(item.price), allDiscounts);
    const bestDiscount = selectedDiscount
      ? { type: String(selectedDiscount.type || '').toUpperCase(), value: selectedDiscount.value, name: selectedDiscount.name }
      : null;

    return NextResponse.json({ ...item, discountRules: allDiscounts, bestDiscount });
  } catch (error) {
    console.error('Error fetching item:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
