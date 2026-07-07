import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { format } from 'date-fns';
import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';
import { getSession } from '@/lib/session';
import { auditExternalApiRequest, auditExternalApiResponse, newAuditCorrelationId } from '@/lib/audit-log';

/**
 * POST /api/direct-payment/initiate
 *
 * Initiates a direct (non-BNPL) payment through the NIB payment gateway.
 * This is completely separate from the loan-repayment flow; it uses
 * DirectPendingPayment / DirectPaymentTransaction tables.
 *
 * Body: { orderId: string; amount: number }
 */
export async function POST(req: NextRequest) {
    // --- Step 1: Environment Validation ---
    const CALLBACK_URL = process.env.CALLBACK_URL; // e.g. https://nibteraloan.nibbank.com.et/api/payment-callback
    const COMPANY_NAME = process.env.COMPANY_NAME;
    const NIB_PAYMENT_KEY = process.env.NIB_PAYMENT_KEY;
    const NIB_PAYMENT_URL = process.env.NIB_PAYMENT_URL;

    if (!CALLBACK_URL || !COMPANY_NAME || !NIB_PAYMENT_KEY || !NIB_PAYMENT_URL) {
        console.error('❌ Missing direct payment gateway environment variables.');
        return NextResponse.json(
            { error: 'Payment gateway is not configured on the server.' },
            { status: 500 },
        );
    }

    // Derive the direct-payment callback from the existing CALLBACK_URL base
    const DIRECT_CALLBACK_URL = CALLBACK_URL.replace(/\/api\/payment-callback\/?$/, '/api/direct-payment/callback');

    try {
        const ipAddress = req.headers.get('x-forwarded-for') || 'N/A';
        const userAgent = req.headers.get('user-agent') || 'N/A';

        // --- Step 2: Parse Request ---
        const body = await req.json();
        const { orderId, amount } = body;

        if (!orderId || !amount) {
            return NextResponse.json({ error: 'Missing orderId or amount.' }, { status: 400 });
        }

        // --- Step 3: Fetch Order + Merchant + Provider (for collection account) ---
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: {
                merchant: { select: { id: true, accountNumber: true, name: true } },
                loanApplication: {
                    select: {
                        product: {
                            select: {
                                provider: {
                                    select: { id: true, collectionAccount: true, accountNumber: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!order) {
            return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
        }
        if (order.paymentType !== 'DIRECT') {
            return NextResponse.json({ error: 'This order is not a direct payment order.' }, { status: 400 });
        }

        // For direct payments, use the Collection Account from the provider.
        // Fallback: try the provider linked via loanApplication, then find the first active provider.
        let receivingAccount: string | null = null;

        // Try from the order's loanApplication -> product -> provider
        const linkedProvider = (order as any).loanApplication?.product?.provider;
        if (linkedProvider?.collectionAccount) {
            receivingAccount = linkedProvider.collectionAccount;
        }

        // Fallback: fetch the first active provider's collection account
        if (!receivingAccount) {
            const provider = await prisma.loanProvider.findFirst({
                where: { status: 'ACTIVE' },
                select: { collectionAccount: true, accountNumber: true },
                orderBy: { displayOrder: 'asc' },
            });
            receivingAccount = provider?.collectionAccount || provider?.accountNumber || null;
        }

        if (!receivingAccount) {
            console.error('❌ No collection account configured on the provider for direct payment.');
            return NextResponse.json(
                { error: 'No collection account is configured for receiving direct payments.' },
                { status: 500 },
            );
        }

        // --- Step 4: Retrieve Session (super app token) ---
        const session = await getSession();
        const superAppToken = session?.superAppToken;

        if (!superAppToken) {
            return NextResponse.json(
                { error: 'Your session has expired or is invalid. Please reconnect from the main app.' },
                { status: 401 },
            );
        }

        // --- Step 5: Generate Transaction Info ---
        const transactionId = randomUUID();
        const transactionTime = format(new Date(), 'yyyyMMddHHmmss');

        const signatureString = [
            `accountNo=${receivingAccount}`,
            `amount=${amount}`,
            `callBackURL=${DIRECT_CALLBACK_URL}`,
            `companyName=${COMPANY_NAME}`,
            `Key=${NIB_PAYMENT_KEY}`,
            `token=${superAppToken}`,
            `transactionId=${transactionId}`,
            `transactionTime=${transactionTime}`,
        ].join('&');

        const signature = createHash('sha256').update(signatureString, 'utf8').digest('hex');

        const payload = {
            accountNo: receivingAccount,
            amount: String(amount),
            callBackURL: DIRECT_CALLBACK_URL,
            companyName: COMPANY_NAME,
            token: superAppToken,
            transactionId,
            transactionTime,
            signature,
        };

        // --- Step 6: Save DirectPendingPayment ---
        await (prisma as any).directPendingPayment.create({
            data: {
                transactionId,
                orderId,
                borrowerId: order.borrowerId,
                merchantId: order.merchantId,
                amount,
                status: 'PENDING',
            },
        });

        await createAuditLog({
            actorId: order.borrowerId,
            action: 'DIRECT_PAYMENT_GATEWAY_REQUEST',
            entity: 'ORDER',
            entityId: orderId,
            details: { transactionId, amount, merchantId: order.merchantId },
        });

        // --- Step 7: Send to Payment Gateway ---
        const correlationId = newAuditCorrelationId();
        const startedAt = Date.now();

        await auditExternalApiRequest(
            {
                actorId: order.borrowerId,
                ipAddress,
                userAgent,
                integration: 'DIRECT_PAYMENT_GATEWAY',
                entity: 'ORDER',
                entityId: orderId,
                correlationId,
            },
            {
                method: 'POST',
                url: NIB_PAYMENT_URL,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${superAppToken}`,
                },
                body: {
                    accountNo: receivingAccount,
                    amount: String(amount),
                    callBackURL: DIRECT_CALLBACK_URL,
                    companyName: COMPANY_NAME,
                    transactionId,
                    transactionTime,
                    token: superAppToken,
                    signature,
                },
            },
        ).catch(() => null);

        const paymentResponse = await fetch(NIB_PAYMENT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${superAppToken}`,
            },
            body: JSON.stringify(payload),
        });

        const responseTextOrJson = await (async () => {
            try {
                const cloned = paymentResponse.clone();
                return await cloned.json();
            } catch {
                try {
                    const cloned = paymentResponse.clone();
                    return await cloned.text();
                } catch {
                    return null;
                }
            }
        })();

        await auditExternalApiResponse(
            {
                actorId: order.borrowerId,
                ipAddress,
                userAgent,
                integration: 'DIRECT_PAYMENT_GATEWAY',
                entity: 'ORDER',
                entityId: orderId,
                correlationId,
            },
            {
                status: paymentResponse.status,
                statusText: (paymentResponse as any).statusText,
                headers: (() => {
                    const headersObj: Record<string, string> = {};
                    try {
                        for (const [k, v] of (paymentResponse.headers as any).entries()) {
                            headersObj[k] = v;
                        }
                    } catch {
                        // ignore
                    }
                    return headersObj;
                })(),
                body: responseTextOrJson,
                durationMs: Date.now() - startedAt,
            },
        ).catch(() => null);

        if (!paymentResponse.ok) {
            const errorData = await paymentResponse.text();
            console.error('❌ DIRECT PAYMENT GATEWAY ERROR:', errorData);
            throw new Error(`Payment gateway request failed: ${errorData}`);
        }

        const responseData = await paymentResponse.json();
        const paymentToken = responseData.token;

        if (!paymentToken) {
            throw new Error('Payment token not received from the gateway.');
        }

        return NextResponse.json({ paymentToken, transactionId });
    } catch (error) {
        console.error('💥 Error initiating direct payment:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
