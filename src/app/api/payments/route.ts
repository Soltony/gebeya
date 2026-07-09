
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { z } from 'zod';
import { calculateTotalRepayable } from '@/lib/loan-calculator';
import { startOfDay, isBefore, isEqual, differenceInDays } from 'date-fns';
import type { RepaymentBehavior } from '@prisma/client';
import { createAuditLog } from '@/lib/audit-log';
import sendSms from '@/lib/sms';
import { MiniAppAuthError, requireMiniAppAuthContext } from '@/lib/miniapp-auth';
import { getAsOfDate } from '@/lib/date-utils';
import { ensureInstallmentRollover } from '@/lib/installment-rollover';
import { computeActiveInstallmentDue, MONEY_EPSILON, LOAN_SETTLE_EPSILON } from '@/lib/repayment-due';
import { INSTALLMENT_STATUS, SETTLED_STATUSES } from '@/lib/installment-status';

const paymentSchema = z.object({
    loanId: z.string(),
    amount: z.number().positive(),
    installmentId: z.string().optional(),
});

export async function POST(req: NextRequest) {
    // repayment actions
    let paymentDetailsForLogging: any = {};
    let borrowerIdForLogging: string | null = null;
    try {
        const ctx = await requireMiniAppAuthContext();
        const body = await req.json();
        const { loanId, amount: paymentAmount } = paymentSchema.parse(body);
        paymentDetailsForLogging = { loanId, amount: paymentAmount };
        
        const loanForBorrowerId = await prisma.loan.findUnique({ where: { id: loanId }, select: { borrowerId: true }});
        borrowerIdForLogging = loanForBorrowerId?.borrowerId || null;

        if (!borrowerIdForLogging || String(borrowerIdForLogging) !== String(ctx.borrowerId)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        await createAuditLog({ actorId: borrowerIdForLogging || 'unknown', action: 'REPAYMENT_INITIATED', entity: 'LOAN', entityId: loanId, details: paymentDetailsForLogging });
       

        const [loan, taxConfigs] = await Promise.all([
            prisma.loan.findUnique({
                where: { id: loanId },
                include: {
                    product: {
                        include: {
                            provider: {
                                include: {
                                    ledgerAccounts: true
                                }
                            }
                        }
                    },
                    // Interest is computed on the declining balance, so the
                    // calculator needs the payment history.
                    payments: { orderBy: { date: 'asc' } }
                }
            }),
            prisma.tax.findMany({ where: { status: 'ACTIVE' } })
        ]);

        if (!loan) {
            throw new Error('Loan not found');
        }

        // Ensure installment rollover: when an installment is past due,
        // close it and merge its amount into the next installment.
        // The next installment becomes active with the combined amount.
        await ensureInstallmentRollover(prisma, loanId);

        const provider = loan.product.provider;
        const paymentDate = getAsOfDate();

        const totals = calculateTotalRepayable(
            loan as any,
            loan.product as any,
            (taxConfigs ?? []) as any,
            paymentDate
        );

        const alreadyRepaid = loan.repaidAmount || 0;
        const totalDue = totals.total - alreadyRepaid;

        const alreadyPaidPenalty = Math.min(totals.penalty, alreadyRepaid);
        const alreadyPaidServiceFee = Math.min(totals.serviceFee, Math.max(0, alreadyRepaid - totals.penalty));
        const alreadyPaidInterest = Math.min(totals.interest, Math.max(0, alreadyRepaid - totals.penalty - totals.serviceFee));
        const alreadyPaidTax = Math.min(totals.tax, Math.max(0, alreadyRepaid - totals.penalty - totals.serviceFee - totals.interest));
        const alreadyPaidPrincipal = Math.min(totals.principal, Math.max(0, alreadyRepaid - totals.penalty - totals.serviceFee - totals.interest - totals.tax));

        const penaltyDue = Math.max(0, totals.penalty - alreadyPaidPenalty);
        const serviceFeeDue = Math.max(0, totals.serviceFee - alreadyPaidServiceFee);
        const interestDue = Math.max(0, totals.interest - alreadyPaidInterest);
        const taxDue = Math.max(0, totals.tax - alreadyPaidTax);
        const principalDue = Math.max(0, totals.principal - alreadyPaidPrincipal);

        // If installmentId is provided, handle installment-level payment
        if (body.installmentId) {
            const installments = await prisma.loanInstallment.findMany({
                where: { loanId },
                orderBy: { installmentNumber: 'asc' },
            });

            // Single source of truth for the amount due (fees are billed by
            // entitlement, never re-billed on repeat payments — see repayment-due.ts).
            const due = computeActiveInstallmentDue(
                loan as any,
                loan.product as any,
                (taxConfigs ?? []) as any,
                installments as any,
                paymentDate
            );
            if (!due) throw new Error('No active installment found for this loan.');

            // Enforce sequential schedule: borrower can only pay the currently active installment.
            if (String(due.installmentId) !== String(body.installmentId)) {
                throw new Error('This installment is not active yet. Please repay the active installment first.');
            }
            const installment = installments.find(i => i.id === due.installmentId)!;

            const penaltyForInstallment = due.penaltyForInstallment;
            const instPenaltyRemaining = due.penaltyRemaining;
            const instServiceFeeDue = due.serviceFeeDue;
            const instInterestDue = due.interestDue;
            const instTaxDue = due.taxDue;
            const instPrincipalRemaining = due.principalRemaining;
            const totalDueForInstallment = due.total;

            if (paymentAmount > totalDueForInstallment + MONEY_EPSILON) {
                throw new Error('Payment amount exceeds balance due.');
            }

            // proceed with transaction similar to loan-level payment but scoped to installment
            const result = await prisma.$transaction(async (tx) => {
                // ledger accounts
                const principalReceivable = provider.ledgerAccounts.find(a => a.category === 'Principal' && a.type === 'Receivable');
                const penaltyReceivable = provider.ledgerAccounts.find(a => a.category === 'Penalty' && a.type === 'Receivable');
                const serviceFeeReceivable = provider.ledgerAccounts.find(a => a.category === 'ServiceFee' && a.type === 'Receivable');
                const interestReceivable = provider.ledgerAccounts.find(a => a.category === 'Interest' && a.type === 'Receivable');
                const taxReceivable = provider.ledgerAccounts.find(a => a.category === 'Tax' && a.type === 'Receivable');
                const principalReceived = provider.ledgerAccounts.find(a => a.category === 'Principal' && a.type === 'Received');
                const penaltyReceived = provider.ledgerAccounts.find(a => a.category === 'Penalty' && a.type === 'Received');
                const serviceFeeReceived = provider.ledgerAccounts.find(a => a.category === 'ServiceFee' && a.type === 'Received');
                const interestReceived = provider.ledgerAccounts.find(a => a.category === 'Interest' && a.type === 'Received');
                const taxReceived = provider.ledgerAccounts.find(a => a.category === 'Tax' && a.type === 'Received');
                const penaltyIncome = provider.ledgerAccounts.find(a => a.category === 'Penalty' && a.type === 'Income');
                const serviceFeeIncome = provider.ledgerAccounts.find(a => a.category === 'ServiceFee' && a.type === 'Income');
                const interestIncome = provider.ledgerAccounts.find(a => a.category === 'Interest' && a.type === 'Income');
                if (!principalReceivable || !principalReceived) throw new Error('Ledger accounts not configured');

                const journalEntry = await tx.journalEntry.create({ data: { providerId: provider.id, loanId, date: paymentDate, description: `Repayment for installment ${installment.installmentNumber} of loan ${loanId}` } });

                let amountToApply = paymentAmount;

                // apply penalty first
                const penaltyToPay = Math.min(amountToApply, instPenaltyRemaining);
                if (penaltyToPay > 0 && penaltyReceivable && penaltyReceived) {
                    await tx.ledgerAccount.update({ where: { id: penaltyReceivable.id }, data: { balance: { decrement: penaltyToPay } } });
                    await tx.ledgerAccount.update({ where: { id: penaltyReceived.id }, data: { balance: { increment: penaltyToPay } } });
                    if (!penaltyIncome) throw new Error('Penalty Income ledger account not configured');
                    await tx.ledgerAccount.update({ where: { id: penaltyIncome.id }, data: { balance: { increment: penaltyToPay } } });
                    await tx.ledgerEntry.createMany({ data: [
                        { journalEntryId: journalEntry.id, ledgerAccountId: penaltyReceivable.id, type: 'Credit', amount: penaltyToPay },
                        { journalEntryId: journalEntry.id, ledgerAccountId: penaltyReceived.id, type: 'Debit', amount: penaltyToPay },
                        { journalEntryId: journalEntry.id, ledgerAccountId: penaltyIncome.id, type: 'Credit', amount: penaltyToPay }
                    ]});
                    amountToApply -= penaltyToPay;
                }

                // service fee share owed with this installment
                const serviceFeeToPay = Math.min(amountToApply, instServiceFeeDue);
                if (serviceFeeToPay > 0) {
                    if (!serviceFeeReceivable || !serviceFeeReceived || !serviceFeeIncome) throw new Error('Service Fee ledger accounts not configured');
                    await tx.ledgerAccount.update({ where: { id: serviceFeeReceivable.id }, data: { balance: { decrement: serviceFeeToPay } } });
                    await tx.ledgerAccount.update({ where: { id: serviceFeeReceived.id }, data: { balance: { increment: serviceFeeToPay } } });
                    await tx.ledgerAccount.update({ where: { id: serviceFeeIncome.id }, data: { balance: { increment: serviceFeeToPay } } });
                    await tx.ledgerEntry.createMany({
                        data: [
                            { journalEntryId: journalEntry.id, ledgerAccountId: serviceFeeReceivable.id, type: 'Credit', amount: serviceFeeToPay },
                            { journalEntryId: journalEntry.id, ledgerAccountId: serviceFeeReceived.id, type: 'Debit', amount: serviceFeeToPay },
                            { journalEntryId: journalEntry.id, ledgerAccountId: serviceFeeIncome.id, type: 'Credit', amount: serviceFeeToPay },
                        ]
                    });
                    amountToApply -= serviceFeeToPay;
                }

                // interest share owed with this installment
                const interestToPay = Math.min(amountToApply, instInterestDue);
                if (interestToPay > 0) {
                    if (!interestReceivable || !interestReceived || !interestIncome) throw new Error('Interest ledger accounts not configured');
                    await tx.ledgerAccount.update({ where: { id: interestReceivable.id }, data: { balance: { decrement: interestToPay } } });
                    await tx.ledgerAccount.update({ where: { id: interestReceived.id }, data: { balance: { increment: interestToPay } } });
                    await tx.ledgerAccount.update({ where: { id: interestIncome.id }, data: { balance: { increment: interestToPay } } });
                    await tx.ledgerEntry.createMany({
                        data: [
                            { journalEntryId: journalEntry.id, ledgerAccountId: interestReceivable.id, type: 'Credit', amount: interestToPay },
                            { journalEntryId: journalEntry.id, ledgerAccountId: interestReceived.id, type: 'Debit', amount: interestToPay },
                            { journalEntryId: journalEntry.id, ledgerAccountId: interestIncome.id, type: 'Credit', amount: interestToPay },
                        ]
                    });
                    amountToApply -= interestToPay;
                }

                // tax share owed with this installment
                const taxToPay = Math.min(amountToApply, instTaxDue);
                if (taxToPay > 0) {
                    if (!taxReceivable || !taxReceived) throw new Error('Tax ledger accounts not configured');
                    await tx.ledgerAccount.update({ where: { id: taxReceivable.id }, data: { balance: { decrement: taxToPay } } });
                    await tx.ledgerAccount.update({ where: { id: taxReceived.id }, data: { balance: { increment: taxToPay } } });
                    await tx.ledgerEntry.createMany({
                        data: [
                            { journalEntryId: journalEntry.id, ledgerAccountId: taxReceivable.id, type: 'Credit', amount: taxToPay },
                            { journalEntryId: journalEntry.id, ledgerAccountId: taxReceived.id, type: 'Debit', amount: taxToPay },
                        ]
                    });
                    amountToApply -= taxToPay;
                }

                const principalToPay = Math.min(amountToApply, instPrincipalRemaining);
                if (principalToPay > 0) {
                    await tx.ledgerAccount.update({ where: { id: principalReceivable.id }, data: { balance: { decrement: principalToPay } } });
                    await tx.ledgerAccount.update({ where: { id: principalReceived.id }, data: { balance: { increment: principalToPay } } });
                    await tx.ledgerEntry.createMany({ data: [
                        { journalEntryId: journalEntry.id, ledgerAccountId: principalReceivable.id, type: 'Credit', amount: principalToPay },
                        { journalEntryId: journalEntry.id, ledgerAccountId: principalReceived.id, type: 'Debit', amount: principalToPay }
                    ]});
                    amountToApply -= principalToPay;
                }

                const paymentRec = await tx.payment.create({ data: { loanId, installmentId: installment.id, amount: paymentAmount, date: paymentDate, outstandingBalanceBeforePayment: totalDueForInstallment, journalEntryId: journalEntry.id } });

                // Only penalty+principal settle an installment. Settled when at
                // most rounding dust (< 1 cent) remains; on settlement, snap
                // paidAmount to the exact amount owed so no dust survives.
                const isFullyPaid =
                    instPrincipalRemaining - principalToPay <= MONEY_EPSILON &&
                    instPenaltyRemaining - penaltyToPay <= MONEY_EPSILON;
                const newPaidAmount = isFullyPaid
                    ? installment.amount + penaltyForInstallment
                    : (installment.paidAmount || 0) + penaltyToPay + principalToPay;

                // Keep current installment active until it is fully paid.
                await tx.loanInstallment.update({
                    where: { id: installment.id },
                    data: {
                        paidAmount: newPaidAmount,
                        paidAt: paymentDate,
                        status: isFullyPaid
                            ? INSTALLMENT_STATUS.Paid
                            : (differenceInDays(paymentDate, installment.dueDate) > 0 ? INSTALLMENT_STATUS.Overdue : INSTALLMENT_STATUS.Pending),
                        penaltyAmount: penaltyForInstallment,
                        isActive: !isFullyPaid,
                    }
                });

                // update loan repaidAmount and if last installment mark loan Paid
                await tx.loan.update({ where: { id: loanId }, data: { repaidAmount: (loan.repaidAmount || 0) + paymentAmount } });

                if (isFullyPaid) {
                    // Activate the next payable installment.
                    // (Merged installments have amount=0 and must be skipped.)
                    const nextPayable = await tx.loanInstallment.findFirst({
                        where: {
                            loanId,
                            installmentNumber: { gt: installment.installmentNumber },
                            status: { notIn: SETTLED_STATUSES },
                            amount: { gt: 0 },
                        },
                        orderBy: { installmentNumber: 'asc' },
                    });

                    if (nextPayable) {
                        await tx.loanInstallment.update({ where: { id: nextPayable.id }, data: { isActive: true } });
                    } else {
                        // Last installment settled — only mark the LOAN paid when
                        // the money received covers the total repayable.
                        const newRepaidTotal = (loan.repaidAmount || 0) + paymentAmount;
                        if (newRepaidTotal >= totals.total - LOAN_SETTLE_EPSILON) {
                            await tx.loan.update({ where: { id: loanId }, data: { repaymentStatus: 'Paid' } });
                        } else {
                            console.error('[payments] all installments settled but loan under-collected; leaving Unpaid', {
                                loanId, repaid: newRepaidTotal, expected: totals.total,
                            });
                        }
                    }
                }

                return { paymentRec };
            });

            return NextResponse.json(result, { status: 200 });
        }


        if (paymentAmount > totalDue + MONEY_EPSILON) {
            throw new Error('Payment amount exceeds balance due.');
        }
        
        const updatedLoan = await prisma.$transaction(async (tx) => {
            let amountToApply = paymentAmount;
            
            // Ledger Accounts
            const principalReceivable = provider.ledgerAccounts.find(a => a.category === 'Principal' && a.type === 'Receivable');
            const interestReceivable = provider.ledgerAccounts.find(a => a.category === 'Interest' && a.type === 'Receivable');
            const penaltyReceivable = provider.ledgerAccounts.find(a => a.category === 'Penalty' && a.type === 'Receivable');
            const serviceFeeReceivable = provider.ledgerAccounts.find(a => a.category === 'ServiceFee' && a.type === 'Receivable');
            const taxReceivable = provider.ledgerAccounts.find(a => a.category === 'Tax' && a.type === 'Receivable');

            const principalReceived = provider.ledgerAccounts.find(a => a.category === 'Principal' && a.type === 'Received');
            const interestReceived = provider.ledgerAccounts.find(a => a.category === 'Interest' && a.type === 'Received');
            const penaltyReceived = provider.ledgerAccounts.find(a => a.category === 'Penalty' && a.type === 'Received');
            const serviceFeeReceived = provider.ledgerAccounts.find(a => a.category === 'ServiceFee' && a.type === 'Received');
            const taxReceived = provider.ledgerAccounts.find(a => a.category === 'Tax' && a.type === 'Received');

            const interestIncome = provider.ledgerAccounts.find(a => a.category === 'Interest' && a.type === 'Income');
            const penaltyIncome = provider.ledgerAccounts.find(a => a.category === 'Penalty' && a.type === 'Income');
            const serviceFeeIncome = provider.ledgerAccounts.find(a => a.category === 'ServiceFee' && a.type === 'Income');
            
            
            if (!principalReceivable || !interestReceivable || !penaltyReceivable || !serviceFeeReceivable || !taxReceivable ||
                !principalReceived || !interestReceived || !penaltyReceived || !serviceFeeReceived || !taxReceived) {
                throw new Error(`One or more ledger accounts not found for provider ${provider.id}`);
            }

            const journalEntry = await tx.journalEntry.create({
                data: {
                    providerId: provider.id,
                    loanId: loan.id,
                    date: paymentDate,
                    description: `Repayment of ${paymentAmount} for loan ${loan.id}`
                }
            });

            // Apply payment according to priority: Penalty -> Service Fee -> Interest -> Tax -> Principal
            const penaltyToPay = Math.min(amountToApply, penaltyDue);
            if (penaltyToPay > 0) {
                await tx.ledgerAccount.update({ where: { id: penaltyReceivable.id }, data: { balance: { decrement: penaltyToPay } } });
                await tx.ledgerAccount.update({ where: { id: penaltyReceived.id }, data: { balance: { increment: penaltyToPay } } });
                if (!penaltyIncome) throw new Error(`Penalty Income ledger account not found for provider ${provider.id}`);
                await tx.ledgerAccount.update({ where: { id: penaltyIncome.id }, data: { balance: { increment: penaltyToPay } } });
                await tx.ledgerEntry.createMany({ data: [
                    { journalEntryId: journalEntry.id, ledgerAccountId: penaltyReceivable.id, type: 'Credit', amount: penaltyToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: penaltyReceived.id, type: 'Debit', amount: penaltyToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: penaltyIncome.id, type: 'Credit', amount: penaltyToPay }
                ]});
                amountToApply -= penaltyToPay;
            }

            const serviceFeeToPay = Math.min(amountToApply, serviceFeeDue);
            if (serviceFeeToPay > 0) {
                await tx.ledgerAccount.update({ where: { id: serviceFeeReceivable.id }, data: { balance: { decrement: serviceFeeToPay } } });
                await tx.ledgerAccount.update({ where: { id: serviceFeeReceived.id }, data: { balance: { increment: serviceFeeToPay } } });
                if (!serviceFeeIncome) throw new Error(`Service Fee Income ledger account not found for provider ${provider.id}`);
                await tx.ledgerAccount.update({ where: { id: serviceFeeIncome.id }, data: { balance: { increment: serviceFeeToPay } } });
                await tx.ledgerEntry.createMany({ data: [
                    { journalEntryId: journalEntry.id, ledgerAccountId: serviceFeeReceivable.id, type: 'Credit', amount: serviceFeeToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: serviceFeeReceived.id, type: 'Debit', amount: serviceFeeToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: serviceFeeIncome.id, type: 'Credit', amount: serviceFeeToPay }
                ]});
                amountToApply -= serviceFeeToPay;
            }

            const interestToPay = Math.min(amountToApply, interestDue);
             if (interestToPay > 0) {
                await tx.ledgerAccount.update({ where: { id: interestReceivable.id }, data: { balance: { decrement: interestToPay } } });
                await tx.ledgerAccount.update({ where: { id: interestReceived.id }, data: { balance: { increment: interestToPay } } });
                if (!interestIncome) throw new Error(`Interest Income ledger account not found for provider ${provider.id}`);
                await tx.ledgerAccount.update({ where: { id: interestIncome.id }, data: { balance: { increment: interestToPay } } });
                await tx.ledgerEntry.createMany({ data: [
                    { journalEntryId: journalEntry.id, ledgerAccountId: interestReceivable.id, type: 'Credit', amount: interestToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: interestReceived.id, type: 'Debit', amount: interestToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: interestIncome.id, type: 'Credit', amount: interestToPay }
                ]});
                amountToApply -= interestToPay;
            }

            const taxToPay = Math.min(amountToApply, taxDue);
            if (taxToPay > 0) {
                await tx.ledgerAccount.update({ where: { id: taxReceivable.id }, data: { balance: { decrement: taxToPay } } });
                await tx.ledgerAccount.update({ where: { id: taxReceived.id }, data: { balance: { increment: taxToPay } } });
                await tx.ledgerEntry.createMany({ data: [
                    { journalEntryId: journalEntry.id, ledgerAccountId: taxReceivable.id, type: 'Credit', amount: taxToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: taxReceived.id, type: 'Debit', amount: taxToPay }
                ]});
                amountToApply -= taxToPay;
            }

            const principalToPay = Math.min(amountToApply, principalDue);
             if (principalToPay > 0) {
                await tx.ledgerAccount.update({ where: { id: principalReceivable.id }, data: { balance: { decrement: principalToPay } } });
                await tx.ledgerAccount.update({ where: { id: principalReceived.id }, data: { balance: { increment: principalToPay } } });
                 await tx.ledgerEntry.createMany({ data: [
                    { journalEntryId: journalEntry.id, ledgerAccountId: principalReceivable.id, type: 'Credit', amount: principalToPay },
                    { journalEntryId: journalEntry.id, ledgerAccountId: principalReceived.id, type: 'Debit', amount: principalToPay }
                ]});
            }

            // Create payment record
            const newPayment = await tx.payment.create({
                data: {
                    loanId,
                    amount: paymentAmount,
                    date: paymentDate,
                    outstandingBalanceBeforePayment: totalDue,
                    journalEntryId: journalEntry.id,
                }
            });

            const newRepaidAmount = alreadyRepaid + paymentAmount;
            const isFullyPaid = newRepaidAmount >= totals.total - LOAN_SETTLE_EPSILON;
            let repaymentBehavior: RepaymentBehavior | null = null;
            
            if (isFullyPaid) {
                const today = startOfDay(new Date());
                const dueDate = startOfDay(loan.dueDate);
                if (isBefore(today, dueDate)) {
                    repaymentBehavior = 'EARLY';
                } else if (isEqual(today, dueDate)) {
                    repaymentBehavior = 'ON_TIME';
                } else {
                    repaymentBehavior = 'LATE';
                }
            }

            const finalLoan = await tx.loan.update({
                where: { id: loanId },
                data: {
                    repaidAmount: newRepaidAmount,
                    repaymentStatus: isFullyPaid ? 'Paid' : 'Unpaid',
                    ...(repaymentBehavior && { repaymentBehavior: repaymentBehavior }),
                },
                include: {
                    payments: { orderBy: { date: 'asc' } },
                    product: true,
                }
            });
            
            const logDetails = {
               loanId: loan.id,
               paymentId: newPayment.id,
               amount: paymentAmount,
               repaymentStatus: finalLoan.repaymentStatus,
            };
            await createAuditLog({ actorId: loan.borrowerId, action: 'REPAYMENT_SUCCESS', entity: 'LOAN', entityId: loan.id, details: logDetails });
           

            // Send SMS notification to borrower for manual repayment
            (async () => {
                try {
                    const phone = loan.borrowerId;
                    const msg = `Payment of ${paymentAmount} ETB received for loan ${loan.id}. Thank you.`;
                    const smsRes = await sendSms(String(phone), msg);
                    if (!smsRes.ok) console.warn('[payments] sms send failed', smsRes);
                } catch (e) {
                    console.error('[payments] sms notify error', e);
                }
            })();

            return finalLoan;
        });

        return NextResponse.json(updatedLoan, { status: 200 });

    } catch (error: any) {
        if (error instanceof MiniAppAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        const errorMessage = (error instanceof z.ZodError) ? error.errors : (error as Error).message;
        const failureLogDetails = {
            ...paymentDetailsForLogging,
            error: errorMessage,
        };
        await createAuditLog({ actorId: borrowerIdForLogging || 'unknown', action: 'REPAYMENT_FAILED', entity: 'LOAN', entityId: paymentDetailsForLogging.loanId, details: failureLogDetails });
        console.error(JSON.stringify({ ...failureLogDetails, timestamp: new Date().toISOString(), action: 'REPAYMENT_FAILED' }));

        if (error instanceof z.ZodError) {
            return NextResponse.json({ error: error.errors }, { status: 400 });
        }
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
    }
}
