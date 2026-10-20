import { NextRequest, NextResponse } from 'next/server';
import { getCatalogItem } from '@/lib/marketplace/catalog';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const item = await getCatalogItem(id);

    if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });

    return NextResponse.json(item);
  } catch (error) {
    console.error('Error fetching item:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
