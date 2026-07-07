import { NextRequest, NextResponse } from 'next/server';
import { getUserFromSession } from '@/lib/user';
import { hasPermission } from '@/lib/permissions';
import { sendSmsToLoan, sendSingleSms, replacePlaceholders } from '@/actions/sms';
import prisma from '@/lib/prisma';

export async function POST(request: NextRequest) {
    try {
        const user = await getUserFromSession();
        if (!user || !hasPermission(user, 'sms-management', 'create')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const data = await request.json();

        // Send to specific loan
        if (data.loanId) {
            const result = await sendSmsToLoan({
                loanId: data.loanId,
                templateId: data.templateId,
                customMessage: data.customMessage,
            });
            return NextResponse.json(result);
        }

        // Send directly to phone number
        if (data.recipientPhone && data.messageContent) {
            const result = await sendSingleSms({
                recipientPhone: data.recipientPhone,
                recipientName: data.recipientName,
                messageContent: data.messageContent,
                templateId: data.templateId,
            });
            return NextResponse.json(result);
        }

        return NextResponse.json({ error: 'Invalid request. Provide either loanId or recipientPhone with messageContent.' }, { status: 400 });
    } catch (error: any) {
        console.error('[API] POST /api/sms/send error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
