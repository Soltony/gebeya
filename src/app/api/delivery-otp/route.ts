import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { sendSms } from '@/lib/sms';
import crypto from 'crypto';

// POST: Generate and send OTP for delivery confirmation
export async function POST(req: NextRequest) {
    try {
        const { orderId } = await req.json();
        if (!orderId) {
            return NextResponse.json({ error: 'orderId is required' }, { status: 400 });
        }

        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { borrower: true },
        });

        if (!order) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        if (order.status !== 'ON_DELIVERY') {
            return NextResponse.json({ error: 'Order must be ON_DELIVERY to confirm delivery' }, { status: 400 });
        }

        // Generate a 6-digit OTP
        const code = crypto.randomInt(100000, 999999).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        // Invalidate any existing unused OTPs for this order
        await prisma.deliveryOtp.updateMany({
            where: { orderId, verified: false },
            data: { verified: true },
        });

        // Create new OTP
        await prisma.deliveryOtp.create({
            data: {
                orderId,
                code,
                expiresAt,
            },
        });

        // Send OTP via SMS to the borrower's phone
        const phone = order.borrowerId; // borrowerId is the phone number
        const smsMessage = `Your delivery confirmation code is: ${code}. It expires in 5 minutes.`;
        const smsResult = await sendSms(phone, smsMessage, { otp: code, orderId });

        if (!smsResult.ok) {
            console.error('[delivery-otp] Failed to send SMS:', smsResult);
        }

        return NextResponse.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        console.error('Error generating delivery OTP:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

// PUT: Verify OTP
export async function PUT(req: NextRequest) {
    try {
        const { orderId, code } = await req.json();
        if (!orderId || !code) {
            return NextResponse.json({ error: 'orderId and code are required' }, { status: 400 });
        }

        const otp = await prisma.deliveryOtp.findFirst({
            where: {
                orderId,
                code,
                verified: false,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (!otp) {
            return NextResponse.json({ error: 'Invalid or expired OTP' }, { status: 400 });
        }

        // Mark OTP as verified
        await prisma.deliveryOtp.update({
            where: { id: otp.id },
            data: { verified: true },
        });

        return NextResponse.json({ success: true, verified: true });
    } catch (error) {
        console.error('Error verifying delivery OTP:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
