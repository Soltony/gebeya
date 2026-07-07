import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';

export async function GET() {
  const user = await getUserFromSession();
  if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  try {
    const where: any = {
      entityType: { in: ['MerchantItem', 'MerchantDiscountRule', 'MerchantLocation'] },
      status: { in: ['PENDING', 'REJECTED'] },
      createdById: user.id,
    };

    const changes = await prisma.pendingChange.findMany({
      where,
      select: {
        id: true,
        entityType: true,
        entityId: true,
        changeType: true,
        payload: true,
        status: true,
        rejectionReason: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(changes.map(c => ({
      ...c,
      createdAt: c.createdAt.toISOString(),
    })));
  } catch (error) {
    console.error('Error fetching pending changes:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
