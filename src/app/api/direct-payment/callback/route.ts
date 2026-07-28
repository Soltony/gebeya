import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/direct-payment/callback
 *
 * DEPRECATED — All payment callbacks are now handled by the unified
 * /api/payment-callback endpoint. This route forwards any stray
 * requests that may still target the old URL.
 *
 * The unified handler differentiates BNPL vs DIRECT payments by looking
 * up the txnRef in PendingPayment and DirectPendingPayment respectively.
 */
export async function POST(request: NextRequest) {
    // Forward to the unified payment-callback handler
    const url = new URL('/api/payment-callback', request.url);
    const bodyText = await request.text();

    const headers = new Headers(request.headers);
    headers.set('Content-Type', 'application/json');

    const forwarded = await fetch(url.toString(), {
        method: 'POST',
        headers,
        body: bodyText,
    });

    const responseBody = await forwarded.text();
    return new NextResponse(responseBody, {
        status: forwarded.status,
        headers: { 'Content-Type': 'application/json' },
    });
}
