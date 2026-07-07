'use server';

import prisma from '@/lib/prisma';
import { sendSms } from '@/lib/sms';
import { createAuditLog } from '@/lib/audit-log';
import { getUserFromSession } from '@/lib/user';
import type { SmsCampaignTargetCriteria, SmsStatus, SmsCampaignStatus } from '@/lib/types';
import { format, differenceInDays } from 'date-fns';

// --------------------------------------
// SMS TEMPLATE ACTIONS
// --------------------------------------

export async function createSmsTemplate(data: {
    name: string;
    content: string;
    description?: string;
}) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    const template = await prisma.smsTemplate.create({
        data: {
            name: data.name,
            content: data.content,
            description: data.description,
            createdById: user.id,
        },
    });

    await createAuditLog({
        actorId: user.id,
        action: 'CREATE',
        entity: 'SmsTemplate',
        entityId: template.id,
        details: JSON.stringify({ name: data.name }),
    });

    return template;
}

export async function updateSmsTemplate(
    id: string,
    data: {
        name?: string;
        content?: string;
        description?: string;
        isActive?: boolean;
    }
) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    const template = await prisma.smsTemplate.update({
        where: { id },
        data,
    });

    await createAuditLog({
        actorId: user.id,
        action: 'UPDATE',
        entity: 'SmsTemplate',
        entityId: template.id,
        details: JSON.stringify(data),
    });

    return template;
}

export async function deleteSmsTemplate(id: string) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    await prisma.smsTemplate.delete({ where: { id } });

    await createAuditLog({
        actorId: user.id,
        action: 'DELETE',
        entity: 'SmsTemplate',
        entityId: id,
    });

    return { success: true };
}

export async function getSmsTemplates() {
    return prisma.smsTemplate.findMany({
        orderBy: { createdAt: 'desc' },
    });
}

export async function getSmsTemplate(id: string) {
    return prisma.smsTemplate.findUnique({ where: { id } });
}

// --------------------------------------
// PLACEHOLDER REPLACEMENT
// --------------------------------------

interface LoanContext {
    borrowerId: string;
    borrowerName?: string;
    loanAmount: number;
    outstandingAmount: number;
    dueDate: Date;
    disbursedDate: Date;
    productName: string;
    providerName: string;
    penaltyAmount: number;
}

export async function replacePlaceholders(template: string, context: LoanContext): Promise<string> {
    const today = new Date();
    const daysOverdue = differenceInDays(today, context.dueDate);

    return template
        .replace(/\{\{borrowerName\}\}/g, context.borrowerName || context.borrowerId)
        .replace(/\{\{borrowerId\}\}/g, context.borrowerId)
        .replace(/\{\{loanAmount\}\}/g, context.loanAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
        .replace(/\{\{outstandingAmount\}\}/g, context.outstandingAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
        .replace(/\{\{dueDate\}\}/g, format(context.dueDate, 'MMM dd, yyyy'))
        .replace(/\{\{disbursedDate\}\}/g, format(context.disbursedDate, 'MMM dd, yyyy'))
        .replace(/\{\{productName\}\}/g, context.productName)
        .replace(/\{\{providerName\}\}/g, context.providerName)
        .replace(/\{\{daysOverdue\}\}/g, Math.max(0, daysOverdue).toString())
        .replace(/\{\{penaltyAmount\}\}/g, context.penaltyAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

// --------------------------------------
// SMS SENDING
// --------------------------------------

export async function sendSingleSms(data: {
    recipientPhone: string;
    recipientName?: string;
    messageContent: string;
    loanId?: string;
    productId?: string;
    productName?: string;
    templateId?: string;
    campaignId?: string;
}) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    // Create SMS log entry
    const smsLog = await prisma.smsLog.create({
        data: {
            templateId: data.templateId || null,
            campaignId: data.campaignId || null,
            recipientPhone: data.recipientPhone,
            recipientName: data.recipientName,
            loanId: data.loanId || null,
            productId: data.productId || null,
            productName: data.productName,
            messageContent: data.messageContent,
            status: 'PENDING',
        },
    });

    try {
        const result = await sendSms(data.recipientPhone, data.messageContent);

        if (result.ok) {
            await prisma.smsLog.update({
                where: { id: smsLog.id },
                data: {
                    status: 'SENT',
                    sentAt: new Date(),
                },
            });

            return { success: true, smsLogId: smsLog.id, status: 'SENT' as SmsStatus };
        } else {
            await prisma.smsLog.update({
                where: { id: smsLog.id },
                data: {
                    status: 'FAILED',
                    errorMessage: result.error || `HTTP ${result.status}`,
                },
            });

            return { success: false, smsLogId: smsLog.id, status: 'FAILED' as SmsStatus, error: result.error };
        }
    } catch (error: any) {
        await prisma.smsLog.update({
            where: { id: smsLog.id },
            data: {
                status: 'FAILED',
                errorMessage: error.message || 'Unknown error',
            },
        });

        return { success: false, smsLogId: smsLog.id, status: 'FAILED' as SmsStatus, error: error.message };
    }
}

export async function resendFailedSms(smsLogId: string) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    const originalSms = await prisma.smsLog.findUnique({ where: { id: smsLogId } });
    if (!originalSms) throw new Error('SMS log not found');
    if (originalSms.status !== 'FAILED') throw new Error('Can only resend failed SMS');

    // Create new SMS log linked to original
    const newSmsLog = await prisma.smsLog.create({
        data: {
            templateId: originalSms.templateId || null,
            campaignId: originalSms.campaignId || null,
            recipientPhone: originalSms.recipientPhone,
            recipientName: originalSms.recipientName,
            loanId: originalSms.loanId || null,
            productId: originalSms.productId || null,
            productName: originalSms.productName,
            messageContent: originalSms.messageContent,
            status: 'PENDING',
            parentSmsId: originalSms.id,
        },
    });

    // Update original SMS retry count
    await prisma.smsLog.update({
        where: { id: smsLogId },
        data: {
            retryCount: { increment: 1 },
            lastRetryAt: new Date(),
        },
    });

    try {
        const result = await sendSms(originalSms.recipientPhone, originalSms.messageContent);

        if (result.ok) {
            await prisma.smsLog.update({
                where: { id: newSmsLog.id },
                data: {
                    status: 'SENT',
                    sentAt: new Date(),
                },
            });

            await createAuditLog({
                actorId: user.id,
                action: 'RESEND',
                entity: 'SmsLog',
                entityId: newSmsLog.id,
                details: JSON.stringify({ originalSmsId: smsLogId }),
            });

            return { success: true, smsLogId: newSmsLog.id };
        } else {
            await prisma.smsLog.update({
                where: { id: newSmsLog.id },
                data: {
                    status: 'FAILED',
                    errorMessage: result.error || `HTTP ${result.status}`,
                },
            });

            return { success: false, smsLogId: newSmsLog.id, error: result.error };
        }
    } catch (error: any) {
        await prisma.smsLog.update({
            where: { id: newSmsLog.id },
            data: {
                status: 'FAILED',
                errorMessage: error.message || 'Unknown error',
            },
        });

        return { success: false, smsLogId: newSmsLog.id, error: error.message };
    }
}

export async function resendFailedSmsBulk(smsLogIds: string[]) {
    const results = await Promise.allSettled(smsLogIds.map(id => resendFailedSms(id)));

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - successful;

    return { successful, failed, total: results.length };
}

// --------------------------------------
// SMS CAMPAIGN ACTIONS
// --------------------------------------

export async function createSmsCampaign(data: {
    name: string;
    templateId?: string;
    targetCriteria: SmsCampaignTargetCriteria;
    customMessage?: string;
    scheduleType: 'IMMEDIATE' | 'SCHEDULED';
    scheduledAt?: Date;
}) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    const campaign = await prisma.smsCampaign.create({
        data: {
            name: data.name,
            templateId: data.templateId,
            targetCriteria: JSON.stringify(data.targetCriteria),
            customMessage: data.customMessage,
            scheduleType: data.scheduleType,
            scheduledAt: data.scheduledAt,
            status: data.scheduleType === 'IMMEDIATE' ? 'PROCESSING' : 'SCHEDULED',
            createdById: user.id,
        },
    });

    await createAuditLog({
        actorId: user.id,
        action: 'CREATE',
        entity: 'SmsCampaign',
        entityId: campaign.id,
        details: JSON.stringify({ name: data.name, scheduleType: data.scheduleType }),
    });

    // If immediate, start processing
    if (data.scheduleType === 'IMMEDIATE') {
        // Fire and forget - the actual sending happens async
        processCampaign(campaign.id).catch(console.error);
    }

    return campaign;
}

export async function getMatchingLoansForCriteria(criteria: SmsCampaignTargetCriteria) {
    const today = new Date();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
        repaymentStatus: criteria.repaymentStatus || undefined,
    };

    // Filter by product
    if (criteria.productIds && criteria.productIds.length > 0) {
        where.productId = { in: criteria.productIds };
    }

    // Filter by provider
    if (criteria.providerIds && criteria.providerIds.length > 0) {
        where.product = { providerId: { in: criteria.providerIds } };
    }

    // Fetch loans
    const loans = await prisma.loan.findMany({
        where,
        include: {
            borrower: true,
            product: {
                include: { provider: true },
            },
            payments: true,
        },
    });

    // Filter by loan age / overdue days in memory
    return loans.filter(loan => {
        const daysSinceDisbursement = differenceInDays(today, loan.disbursedDate);
        const daysOverdue = differenceInDays(today, loan.dueDate);

        // Loan age filter
        if (criteria.loanAgeFrom !== undefined && daysSinceDisbursement < criteria.loanAgeFrom) {
            return false;
        }
        if (criteria.loanAgeTo !== undefined && daysSinceDisbursement > criteria.loanAgeTo) {
            return false;
        }

        // Overdue filter
        if (criteria.overdueFrom !== undefined && daysOverdue < criteria.overdueFrom) {
            return false;
        }
        if (criteria.overdueTo !== undefined && daysOverdue > criteria.overdueTo) {
            return false;
        }

        // Custom date filters
        if (criteria.customDateField && criteria.customDateFrom) {
            const dateField = criteria.customDateField === 'disbursedDate' ? loan.disbursedDate : loan.dueDate;
            if (dateField < new Date(criteria.customDateFrom)) {
                return false;
            }
        }
        if (criteria.customDateField && criteria.customDateTo) {
            const dateField = criteria.customDateField === 'disbursedDate' ? loan.disbursedDate : loan.dueDate;
            if (dateField > new Date(criteria.customDateTo)) {
                return false;
            }
        }

        return true;
    });
}

export async function previewCampaignRecipients(criteria: SmsCampaignTargetCriteria) {
    const loans = await getMatchingLoansForCriteria(criteria);

    return {
        count: loans.length,
        preview: loans.slice(0, 10).map(loan => ({
            borrowerId: loan.borrowerId,
            productName: loan.product.name,
            providerName: loan.product.provider.name,
            loanAmount: loan.loanAmount,
            dueDate: loan.dueDate,
            disbursedDate: loan.disbursedDate,
            daysOverdue: Math.max(0, differenceInDays(new Date(), loan.dueDate)),
        })),
    };
}

export async function processCampaign(campaignId: string) {
    const campaign = await prisma.smsCampaign.findUnique({
        where: { id: campaignId },
        include: { template: true },
    });

    if (!campaign) throw new Error('Campaign not found');
    if (campaign.status !== 'PROCESSING' && campaign.status !== 'SCHEDULED') {
        throw new Error('Campaign is not in a processable state');
    }

    // Update campaign to processing
    await prisma.smsCampaign.update({
        where: { id: campaignId },
        data: {
            status: 'PROCESSING',
            startedAt: new Date(),
        },
    });

    const criteria: SmsCampaignTargetCriteria = JSON.parse(campaign.targetCriteria);
    const loans = await getMatchingLoansForCriteria(criteria);

    const messageTemplate = campaign.customMessage || campaign.template?.content || '';

    // Update total recipients
    await prisma.smsCampaign.update({
        where: { id: campaignId },
        data: { totalRecipients: loans.length },
    });

    let sentCount = 0;
    let failedCount = 0;

    for (const loan of loans) {
        const totalPaid = loan.payments.reduce((sum, p) => sum + p.amount, 0);
        const outstandingAmount = loan.loanAmount + loan.serviceFee + loan.penaltyAmount - totalPaid;

        const context: LoanContext = {
            borrowerId: loan.borrowerId,
            loanAmount: loan.loanAmount,
            outstandingAmount: Math.max(0, outstandingAmount),
            dueDate: loan.dueDate,
            disbursedDate: loan.disbursedDate,
            productName: loan.product.name,
            providerName: loan.product.provider.name,
            penaltyAmount: loan.penaltyAmount,
        };

        const messageContent = await replacePlaceholders(messageTemplate, context);

        const result = await sendSingleSms({
            recipientPhone: loan.borrowerId,
            messageContent,
            loanId: loan.id,
            productId: loan.productId,
            productName: loan.product.name,
            templateId: campaign.templateId ?? undefined,
            campaignId: campaign.id,
        });

        if (result.success) {
            sentCount++;
        } else {
            failedCount++;
        }

        // Update campaign progress
        await prisma.smsCampaign.update({
            where: { id: campaignId },
            data: { sentCount, failedCount },
        });
    }

    // Mark campaign as completed
    await prisma.smsCampaign.update({
        where: { id: campaignId },
        data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            deliveredCount: sentCount, // For now, treat sent as delivered
        },
    });

    return { sentCount, failedCount, total: loans.length };
}

export async function cancelCampaign(campaignId: string) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    const campaign = await prisma.smsCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.status !== 'SCHEDULED' && campaign.status !== 'DRAFT') {
        throw new Error('Can only cancel scheduled or draft campaigns');
    }

    await prisma.smsCampaign.update({
        where: { id: campaignId },
        data: { status: 'CANCELLED' },
    });

    await createAuditLog({
        actorId: user.id,
        action: 'CANCEL',
        entity: 'SmsCampaign',
        entityId: campaignId,
    });

    return { success: true };
}

export async function getSmsCampaigns(status?: SmsCampaignStatus) {
    return prisma.smsCampaign.findMany({
        where: status ? { status } : undefined,
        include: { template: true },
        orderBy: { createdAt: 'desc' },
    });
}

export async function getSmsCampaign(id: string) {
    return prisma.smsCampaign.findUnique({
        where: { id },
        include: {
            template: true,
            smsLogs: {
                orderBy: { createdAt: 'desc' },
                take: 100,
            },
        },
    });
}

// --------------------------------------
// SMS LOGS/HISTORY
// --------------------------------------

export async function getSmsLogs(params: {
    status?: SmsStatus;
    campaignId?: string;
    productId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
}) {
    const { status, campaignId, productId, search, page = 1, pageSize = 50 } = params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (status) where.status = status;
    if (campaignId) where.campaignId = campaignId;
    if (productId) where.productId = productId;
    if (search) {
        where.OR = [
            { recipientPhone: { contains: search } },
            { recipientName: { contains: search } },
            { messageContent: { contains: search } },
        ];
    }

    const [logs, total] = await Promise.all([
        prisma.smsLog.findMany({
            where,
            include: { template: true, campaign: true },
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.smsLog.count({ where }),
    ]);

    return {
        logs,
        pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
        },
    };
}

export async function getSmsStats() {
    const [total, sent, delivered, failed, pending] = await Promise.all([
        prisma.smsLog.count(),
        prisma.smsLog.count({ where: { status: 'SENT' } }),
        prisma.smsLog.count({ where: { status: 'DELIVERED' } }),
        prisma.smsLog.count({ where: { status: 'FAILED' } }),
        prisma.smsLog.count({ where: { status: 'PENDING' } }),
    ]);

    return { total, sent, delivered, failed, pending };
}

// --------------------------------------
// QUICK SEND (Send SMS to specific loan)
// --------------------------------------

export async function sendSmsToLoan(data: {
    loanId: string;
    templateId?: string;
    customMessage?: string;
}) {
    const user = await getUserFromSession();
    if (!user) throw new Error('Unauthorized');

    const loan = await prisma.loan.findUnique({
        where: { id: data.loanId },
        include: {
            product: { include: { provider: true } },
            payments: true,
        },
    });

    if (!loan) throw new Error('Loan not found');

    let messageTemplate = data.customMessage;

    if (!messageTemplate && data.templateId) {
        const template = await prisma.smsTemplate.findUnique({ where: { id: data.templateId } });
        if (!template) throw new Error('Template not found');
        messageTemplate = template.content;
    }

    if (!messageTemplate) throw new Error('Message content required');

    const totalPaid = loan.payments.reduce((sum, p) => sum + p.amount, 0);
    const outstandingAmount = loan.loanAmount + loan.serviceFee + loan.penaltyAmount - totalPaid;

    const context: LoanContext = {
        borrowerId: loan.borrowerId,
        loanAmount: loan.loanAmount,
        outstandingAmount: Math.max(0, outstandingAmount),
        dueDate: loan.dueDate,
        disbursedDate: loan.disbursedDate,
        productName: loan.product.name,
        providerName: loan.product.provider.name,
        penaltyAmount: loan.penaltyAmount,
    };

    const messageContent = await replacePlaceholders(messageTemplate, context);

    return sendSingleSms({
        recipientPhone: loan.borrowerId,
        messageContent,
        loanId: loan.id,
        productId: loan.productId,
        productName: loan.product.name,
        templateId: data.templateId,
    });
}
