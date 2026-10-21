import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { affiliateErrorResponse, requireAffiliateUser } from '@/lib/affiliate/requests';
import { getPointsSettings } from '@/lib/affiliate/points';

/** Names for the program builder's filters and the affiliate form. */
export async function GET() {
  const auth = await requireAffiliateUser('read');
  if (auth.response) return auth.response;

  try {
    const [providers, products, merchants, categories, programs, points] = await Promise.all([
      prisma.loanProvider.findMany({ select: { id: true, name: true }, orderBy: { displayOrder: 'asc' } }),
      prisma.loanProduct.findMany({ select: { id: true, name: true, providerId: true }, orderBy: { name: 'asc' } }),
      prisma.merchant.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.affiliateProgram.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: 'asc' } }),
      getPointsSettings(),
    ]);
    // The point value lets the program builder show what a points reward is worth.
    return NextResponse.json({ providers, products, merchants, categories, programs, pointValue: points.settings.pointValue });
  } catch (error) {
    return affiliateErrorResponse(error, 'GET /api/affiliates/options');
  }
}
