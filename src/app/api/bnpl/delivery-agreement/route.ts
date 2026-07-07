import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

/**
 * GET /api/bnpl/delivery-agreement?providerId=...
 *
 * Borrower-facing endpoint to fetch the active delivery agreement content
 * for a given provider. This mirrors how /api/borrowers/agreements works
 * for the terms & conditions (accessible via mini-app auth, not admin auth).
 */
export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const providerId = searchParams.get('providerId');

    if (!providerId) {
        return NextResponse.json({ error: 'Provider ID is required' }, { status: 400 });
    }

    try {
        const template = await prisma.deliveryAgreementTemplate.findFirst({
            where: { providerId, isActive: true },
            orderBy: { version: 'desc' },
        });

        return NextResponse.json({
            content: template?.content ?? '',
            version: template?.version ?? 0,
        });
    } catch (error) {
        console.error('Error fetching delivery agreement:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
