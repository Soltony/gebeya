import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getUserFromSession } from '@/lib/user';
import { orderRef } from '@/lib/marketplace/order-status';
import { telegramNamesByBorrower } from '@/lib/direct-payment-rows';
import { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear, isValid } from 'date-fns';

const getDates = (timeframe: string, from?: string, to?: string) => {
    if (from && to) {
        const fromDate = new Date(from);
        const toDate = new Date(to);
        if (isValid(fromDate) && isValid(toDate)) {
            return { gte: startOfDay(fromDate), lte: endOfDay(toDate) };
        }
    }
    const now = new Date();
    switch (timeframe) {
        case 'daily':
            return { gte: startOfDay(now), lte: endOfDay(now) };
        case 'weekly':
            return { gte: startOfWeek(now, { weekStartsOn: 1 }), lte: endOfWeek(now, { weekStartsOn: 1 }) };
        case 'monthly':
            return { gte: startOfMonth(now), lte: endOfMonth(now) };
        case 'quarterly': {
            const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
            return { gte: startOfMonth(new Date(now.getFullYear(), qStartMonth, 1)), lte: endOfMonth(new Date(now.getFullYear(), qStartMonth + 2, 1)) };
        }
        case 'semiAnnually': {
            const year = now.getFullYear();
            if (now.getMonth() < 6) {
                return { gte: startOfMonth(new Date(year, 0, 1)), lte: endOfMonth(new Date(year, 5, 1)) };
            } else {
                return { gte: startOfMonth(new Date(year, 6, 1)), lte: endOfMonth(new Date(year, 11, 1)) };
            }
        }
        case 'annually':
        case 'yearly':
            return { gte: startOfYear(now), lte: endOfYear(now) };
        case 'overall':
        default:
            return { gte: undefined, lte: undefined };
    }
};

export async function GET(req: NextRequest) {
    const user = await getUserFromSession();
    if (!user || !user.permissions?.['reports']?.read) {
        return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const timeframe = searchParams.get('timeframe') || 'overall';
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;
    const search = searchParams.get('search') || undefined;
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(searchParams.get('pageSize')) || 50));

    const dates = getDates(timeframe, from, to);

    const where: any = {};

    if (dates.gte || dates.lte) {
        where.createdAt = {};
        if (dates.gte) where.createdAt.gte = dates.gte;
        if (dates.lte) where.createdAt.lte = dates.lte;
    }

    if (search) {
        where.OR = [
            { transactionId: { contains: search } },
            { orderId: { contains: search.replace(/^#/, '').toLowerCase() } },
            { borrowerId: { contains: search } },
            { merchant: { name: { contains: search } } },
            { ft: { cbsReference: { contains: search } } },
        ];
    }

    try {
        const [total, records] = await Promise.all([
            prisma.directPendingPayment.count({ where }),
            prisma.directPendingPayment.findMany({
                where,
                // An explicit select so the attempt's keys are never loaded.
                select: {
                    id: true,
                    transactionId: true,
                    orderId: true,
                    borrowerId: true,
                    merchantId: true,
                    customerPhone: true,
                    amount: true,
                    status: true,
                    method: true,
                    statusDesc: true,
                    createdAt: true,
                    updatedAt: true,
                    completedAt: true,
                    order: {
                        select: {
                            id: true,
                            totalAmount: true,
                            status: true,
                            paymentType: true,
                            channel: true,
                            createdAt: true,
                        },
                    },
                    borrower: {
                        select: {
                            id: true,
                            provisionedData: {
                                select: { data: true },
                                take: 1,
                                orderBy: { createdAt: 'desc' as const },
                            },
                        },
                    },
                    merchant: {
                        select: {
                            id: true,
                            name: true,
                            accountNumber: true,
                        },
                    },
                    ft: { select: { cbsReference: true } },
                },
                orderBy: { createdAt: 'desc' as const },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);

        const ids = records.map((r) => r.id);
        const [telegramNames, approvals] = await Promise.all([
            telegramNamesByBorrower(records.map((r) => r.borrowerId)),
            ids.length
                ? prisma.pendingChange.findMany({
                      where: { status: 'PENDING', entityType: 'DirectPaymentResolve', entityId: { in: ids } },
                      select: { entityId: true },
                  })
                : [],
        ]);
        const awaitingApproval = new Set(approvals.map((a) => a.entityId));

        const data = records.map((r: any) => {
            // Telegram customers have no provisioned data: their name comes from
            // Telegram, and the borrower id is the phone number either way.
            let borrowerName = telegramNames.get(r.borrowerId) ?? 'N/A';
            let borrowerPhone = r.customerPhone || r.borrowerId;
            if (r.borrower?.provisionedData?.[0]?.data) {
                try {
                    const parsed = JSON.parse(r.borrower.provisionedData[0].data);
                    const nameKey = Object.keys(parsed).find(
                        (k) => k.toLowerCase() === 'fullname' || k.toLowerCase() === 'full name' || k.toLowerCase() === 'customername'
                    );
                    const phoneKey = Object.keys(parsed).find(
                        (k) => k.toLowerCase() === 'phonenumber' || k.toLowerCase() === 'phone number' || k.toLowerCase() === 'mobilenumber'
                    );
                    if (nameKey && parsed[nameKey]) borrowerName = parsed[nameKey];
                    if (phoneKey && parsed[phoneKey]) borrowerPhone = parsed[phoneKey];
                } catch {}
            }

            return {
                id: r.id,
                transactionId: r.transactionId,
                orderId: r.orderId,
                orderRef: orderRef(r.orderId),
                channel: r.order?.channel || 'SUPER_APP',
                borrowerId: r.borrowerId,
                borrowerPhone,
                borrowerName,
                merchantId: r.merchantId,
                merchantName: r.merchant?.name || '',
                merchantAccount: r.merchant?.accountNumber || '',
                amount: r.amount,
                status: r.status,
                method: r.method,
                cbsReference: r.ft?.cbsReference || '',
                statusDesc: r.statusDesc || '',
                orderStatus: r.order?.status || '',
                awaitingApproval: awaitingApproval.has(r.id),
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                completedAt: r.completedAt,
            };
        });

        const totalPages = Math.ceil(total / pageSize);
        return NextResponse.json({ data, total, page, pageSize, totalPages });
    } catch (error) {
        console.error('Error fetching direct payments report:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
