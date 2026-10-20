import { NextRequest, NextResponse } from 'next/server';
import { listActiveCategories, listActiveMerchants, listCatalogItems } from '@/lib/marketplace/catalog';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search') || '';
    const categoryId = searchParams.get('categoryId') || '';
    const merchantId = searchParams.get('merchantId') || '';

    const itemsWithDiscounts = await listCatalogItems({ search, categoryId, merchantId });
    const categories = await listActiveCategories();
    const merchants = await listActiveMerchants();

    return NextResponse.json({ items: itemsWithDiscounts, categories, merchants });
  } catch (error) {
    console.error('Error fetching shop items:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
