import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';

/**
 * POST /api/direct-payment/callback
 *
 * Webhook called by the NIB payment gateway after a direct (non-BNPL)
 * payment is completed. This is separate from the loan-repayment callback.
 *
 * Flow:
 * 1. Validate auth token
 * 2. Log the transaction in DirectPaymentTransaction
 * 3. Find matching DirectPendingPayment by txnRef
 * 4. Mark the order as DELIVERED (payment confirmed)
 * 5. Update DirectPendingPayment status to COMPLETED
 */

async function validateAuthHeader(authHeader: string | null) {
    const TOKEN_VALIDATION_API_URL = process.env.TOKEN_VALIDATION_API_URL;
    if (!TOKEN_VALIDATION_API_URL) {
        throw new Error('Token validation URL is not configured.');
    }
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('Authorization header is malformed or missing.');
    }

    const response = await fetch(TOKEN_VALIDATION_API_URL, {
        method: 'GET',
        headers: {
            Authorization: authHeader,
            Accept: 'application/json',
        },
        cache: 'no-store',
    });

    if (!response.ok) {
        const errorData = await response.text();
        console.error('Token validation failed:', errorData);
        throw new Error('External token validation failed.');
    }

    return true;
}

export async function POST(request: NextRequest) {
    let requestBody: any;
    try {
        requestBody = await request.json();

        // ✅ Extract and normalize Authorization header
        const authHeader = request.headers.get('Authorization');
        let fixedAuthHeader: string | null = null;

        if (authHeader) {
            const tokenMatch = authHeader.match(/"token"\s*:\s*"([^"]+)"/);
            const rawToken = tokenMatch?.[1];
            fixedAuthHeader = rawToken ? `Bearer ${rawToken}` : authHeader;
        }

        if (!fixedAuthHeader) {
            throw new Error('Invalid Authorization header format.');
        }

        await validateAuthHeader(fixedAuthHeader);
    } catch (e: any) {
        console.error('Direct Payment Callback Error: validation failed.', e);
        return NextResponse.json(
            { message: e.message || 'Authentication or parsing error.' },
            { status: 400 },
        );
    }

    const {
        paidAmount,
        txnRef,
        transactionId,
    } = requestBody;

    // --- Log DirectPaymentTransaction ---
    try {
        const existing = await (prisma as any).directPaymentTransaction.findFirst({
            where: {
                OR: [
                    transactionId ? { transactionId } : undefined,
                    txnRef ? { txnRef } : undefined,
                ].filter(Boolean),
            },
        });

        if (existing) {
            await (prisma as any).directPaymentTransaction.update({
                where: { id: existing.id },
                data: {
                    status: 'RECEIVED',
                    payload: JSON.stringify(requestBody),
                    transactionId: transactionId || existing.transactionId,
                    txnRef: txnRef || existing.txnRef,
                },
            });
        } else {
            await (prisma as any).directPaymentTransaction.create({
                data: {
                    transactionId: transactionId || txnRef,
                    txnRef: txnRef ?? null,
                    status: 'RECEIVED',
                    payload: JSON.stringify(requestBody),
                },
            });
        }
    } catch (e) {
        console.error('Failed to log direct payment transaction:', e);
    }

    // --- Process the payment ---
    try {
        const pendingPayment = await (prisma as any).directPendingPayment.findUnique({
            where: { transactionId: txnRef },
        });

        if (!pendingPayment) {
            console.error(`Direct Payment Callback: No pending payment found for txnRef: ${txnRef}`);
            return NextResponse.json(
                { message: 'Transaction reference not found or already processed.' },
                { status: 200 },
            );
        }

        if (pendingPayment.status === 'COMPLETED') {
            return NextResponse.json(
                { message: 'Payment already processed.' },
                { status: 200 },
            );
        }

        const { orderId, borrowerId, merchantId, amount: expectedAmount } = pendingPayment;

        // Update order status to DELIVERED
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        if (!order) {
            throw new Error(`Order ${orderId} not found.`);
        }

        // Only move to DELIVERED if the order is in an appropriate state
        if (order.status === 'ON_DELIVERY' || order.status === 'PENDING_MERCHANT_CONFIRMATION') {
            await prisma.order.update({
                where: { id: orderId },
                data: { status: 'DELIVERED' },
            });
        }

        // Mark the DirectPendingPayment as COMPLETED
        await (prisma as any).directPendingPayment.update({
            where: { transactionId: txnRef },
            data: { status: 'COMPLETED' },
        });

        // Update the DirectPaymentTransaction with orderId
        await (prisma as any).directPaymentTransaction.updateMany({
            where: {
                OR: [
                    { transactionId: transactionId || undefined },
                    { txnRef: txnRef || undefined },
                ].filter(Boolean),
            },
            data: {
                status: 'PROCESSED',
                orderId,
            },
        });

        await createAuditLog({
            actorId: borrowerId,
            action: 'DIRECT_PAYMENT_SUCCESS',
            entity: 'ORDER',
            entityId: orderId,
            details: {
                transactionId,
                txnRef,
                paidAmount,
                merchantId,
                expectedAmount,
            },
        });

        return NextResponse.json({ message: 'Direct payment processed successfully.' }, { status: 200 });
    } catch (e: any) {
        console.error('Direct Payment Callback processing error:', e);
        return NextResponse.json(
            { message: e.message || 'Internal processing error.' },
            { status: 500 },
        );
    }
}
