import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';

export async function GET(req: NextRequest) {
    const user = await getUserFromSession();
    if (!user || !user.permissions?.['reports']?.read) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type'); // 'branches' or 'merchants'

    try {
        if (type === 'merchants') {
            // Get merchants for a specific branch
            const branchId = searchParams.get('branchId');
            if (!branchId) {
                return NextResponse.json({ error: 'branchId is required' }, { status: 400 });
            }

            const page = Math.max(1, Number(searchParams.get('page')) || 1);
            const pageSize = Math.min(200, Math.max(1, Number(searchParams.get('pageSize')) || 50));

            const [total, merchants] = await Promise.all([
                prisma.merchant.count({ where: { branchId } }),
                prisma.merchant.findMany({
                    where: { branchId },
                    select: {
                        id: true,
                        name: true,
                        status: true,
                        createdAt: true,
                    },
                    orderBy: { name: 'asc' },
                    skip: (page - 1) * pageSize,
                    take: pageSize,
                }),
            ]);

            const totalPages = Math.ceil(total / pageSize);
            return NextResponse.json({
                data: merchants.map((m) => ({
                    merchantId: m.id,
                    merchantName: m.name,
                    registrationDate: m.createdAt,
                    status: m.status,
                })),
                total,
                page,
                pageSize,
                totalPages,
            });
        }

        // Default: Branch Subscription Report
        const search = searchParams.get('search') || undefined;
        const districtId = searchParams.get('districtId') || undefined;
        const status = searchParams.get('status') || undefined;
        const dateFilter = searchParams.get('date') || undefined;
        const page = Math.max(1, Number(searchParams.get('page')) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(searchParams.get('pageSize')) || 50));

        const where: any = {};

        if (districtId && districtId !== 'all') {
            where.districtId = districtId;
        }
        if (status && status !== 'all') {
            where.status = status.toUpperCase();
        }
        if (dateFilter) {
            const date = new Date(dateFilter);
            if (!isNaN(date.getTime())) {
                const start = new Date(date);
                start.setHours(0, 0, 0, 0);
                const end = new Date(date);
                end.setHours(23, 59, 59, 999);
                where.createdAt = { gte: start, lte: end };
            }
        }
        if (search) {
            where.OR = [
                { name: { contains: search } },
                { id: { contains: search } },
            ];
        }

        const [total, branches] = await Promise.all([
            prisma.branch.count({ where }),
            prisma.branch.findMany({
                where,
                include: {
                    district: { select: { id: true, name: true } },
                    _count: { select: { merchants: true } },
                },
                orderBy: { name: 'asc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);

        const totalPages = Math.ceil(total / pageSize);
        return NextResponse.json({
            data: branches.map((b) => ({
                branchId: b.id,
                branchName: b.name,
                branchCode: b.id,
                districtId: b.districtId,
                districtName: b.district.name,
                subscriptionDate: b.createdAt,
                merchantCount: b._count.merchants,
                status: b.status,
            })),
            total,
            page,
            pageSize,
            totalPages,
        });
    } catch (error) {
        console.error('Error fetching subscription report:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
