import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { createAuditLog } from '@/lib/audit-log';

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

        // Also check for any pending approval
        const pending = await prisma.pendingChange.findFirst({
            where: {
                entityType: 'DeliveryAgreementTemplate',
                status: 'PENDING',
            },
            orderBy: { createdAt: 'desc' },
            include: { createdBy: { select: { fullName: true } } },
        });

        // Filter pending to this provider
        let pendingForProvider = null;
        if (pending) {
            try {
                const payload = JSON.parse(pending.payload);
                if (payload?.created?.providerId === providerId) {
                    pendingForProvider = {
                        id: pending.id,
                        createdBy: pending.createdBy.fullName,
                        createdAt: pending.createdAt,
                    };
                }
            } catch { /* ignore */ }
        }

        return NextResponse.json({
            template,
            content: template?.content ?? '',
            pending: pendingForProvider,
        });
    } catch (error) {
        console.error('Error fetching delivery agreement:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const session = await getSession();
    if (!session?.userId) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const { providerId, content } = await req.json();

        if (!providerId || !content) {
            return NextResponse.json({ error: 'Provider ID and content are required' }, { status: 400 });
        }

        // Get current version number for the pending change payload
        const latest = await prisma.deliveryAgreementTemplate.findFirst({
            where: { providerId },
            orderBy: { version: 'desc' },
        });
        const nextVersion = (latest?.version || 0) + 1;

        // Create as a pending change instead of immediately publishing
        const pendingChange = await prisma.pendingChange.create({
            data: {
                entityType: 'DeliveryAgreementTemplate',
                changeType: 'CREATE',
                payload: JSON.stringify({
                    created: {
                        providerId,
                        content,
                        version: nextVersion,
                    },
                }),
                status: 'PENDING',
                createdById: session.userId,
            },
        });

        await createAuditLog({
            actorId: session.userId,
            action: 'CHANGE_REQUEST_CREATED',
            entity: 'DeliveryAgreementTemplate',
            details: { changeRequestId: pendingChange.id, changeType: 'CREATE', version: nextVersion },
        });

        return NextResponse.json({ message: 'Submitted for approval', version: nextVersion, changeId: pendingChange.id }, { status: 201 });
    } catch (error) {
        console.error('Error creating delivery agreement change request:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
