
'use server';

import prisma from '@/lib/prisma';
import { createAuditLog } from '@/lib/audit-log';

export interface EligibilityResult {
  isEligible: boolean;
  reason?: string;
  activeFinancing?: {
    type: 'LOAN' | 'BNPL_ORDER' | 'PENDING_DISBURSEMENT';
    id: string;
    status: string;
  };
}

/**
 * Validates whether a borrower may take on new financing (a loan or a BNPL order).
 *
 * A borrower is NOT eligible when they have:
 * - NPL status
 * - An active (Unpaid) loan
 * - An active BNPL order — one that is not yet DELIVERED (which turns into a loan)
 *   or CANCELLED. Direct-payment orders are ignored: they carry no credit exposure.
 * - A pending disbursement on an unpaid loan
 * - A loan application still in progress
 *
 * @param borrowerId Borrower to validate
 * @param actorId    Optional acting user, used for audit logging of blocked attempts
 * @param options    `excludeOrderId` / `excludeLoanId` skip the record being acted on;
 *                   `includePending` (default true) also blocks on orders that are still
 *                   awaiting merchant confirmation — set false to only block on ON_DELIVERY.
 */
export async function validateBorrowerEligibility(
  borrowerId: string,
  actorId?: string,
  options?: { excludeOrderId?: string; excludeLoanId?: string; includePending?: boolean }
): Promise<EligibilityResult> {
  // Default to strict validation (used when creating new financing).
  const includePending = options?.includePending ?? true;

  // 1. Borrower status (NPL)
  const borrower = await prisma.borrower.findUnique({
    where: { id: borrowerId },
    select: { status: true },
  });

  if (!borrower) {
    return { isEligible: false, reason: 'Customer profile not found.' };
  }

  if (borrower.status === 'NPL') {
    const result = {
      isEligible: false,
      reason: 'Customer account is restricted due to non-performing loan (NPL) status.',
    };
    if (actorId) await logBlockedAttempt(actorId, borrowerId, result.reason);
    return result;
  }

  // 2. Active loans
  const activeLoan = await prisma.loan.findFirst({
    where: {
      borrowerId,
      repaymentStatus: 'Unpaid',
      ...(options?.excludeLoanId ? { id: { not: options.excludeLoanId } } : {}),
    },
    select: { id: true, repaymentStatus: true },
  });

  if (activeLoan) {
    const result = {
      isEligible: false,
      reason: 'You already have an active loan. Please repay it before placing a new BNPL order.',
      activeFinancing: { type: 'LOAN' as const, id: activeLoan.id, status: activeLoan.repaymentStatus },
    };
    if (actorId) await logBlockedAttempt(actorId, borrowerId, result.reason, { loanId: activeLoan.id });
    return result;
  }

  // 3. Active BNPL orders
  // An order is "active" until it is DELIVERED (it then becomes a loan) or CANCELLED.
  // includePending=true (default) also blocks while the merchant has yet to confirm;
  // includePending=false only blocks once the order is ON_DELIVERY.
  const activeOrder = await prisma.order.findFirst({
    where: {
      borrowerId,
      paymentType: { not: 'DIRECT' },
      status: {
        in: includePending ? ['PENDING_MERCHANT_CONFIRMATION', 'ON_DELIVERY'] : ['ON_DELIVERY'],
      },
      ...(options?.excludeOrderId ? { id: { not: options.excludeOrderId } } : {}),
    },
    select: { id: true, status: true },
  });

  if (activeOrder) {
    const result = {
      isEligible: false,
      reason: 'You already have an active BNPL order in progress. Please complete or cancel it before placing another.',
      activeFinancing: { type: 'BNPL_ORDER' as const, id: activeOrder.id, status: activeOrder.status },
    };
    if (actorId) await logBlockedAttempt(actorId, borrowerId, result.reason, { orderId: activeOrder.id });
    return result;
  }

  // 4. Pending disbursements
  // Only disbursements on still-unpaid loans matter: once a loan is repaid its
  // disbursement status should not block new financing.
  const pendingDisbursement = await prisma.disbursementTransaction.findFirst({
    where: {
      loan: {
        borrowerId,
        repaymentStatus: 'Unpaid',
      },
      disbursementStatus: { in: ['PENDING', 'SENT'] },
      ...(options?.excludeLoanId ? { loanId: { not: options.excludeLoanId } } : {}),
    },
    select: { id: true, disbursementStatus: true, loanId: true },
  });

  if (pendingDisbursement) {
    const result = {
      isEligible: false,
      reason: 'You have a pending disbursement. Please wait for it to complete.',
      activeFinancing: {
        type: 'PENDING_DISBURSEMENT' as const,
        id: pendingDisbursement.id,
        status: pendingDisbursement.disbursementStatus,
      },
    };
    if (actorId) {
      await logBlockedAttempt(actorId, borrowerId, result.reason, {
        disbursementTransactionId: pendingDisbursement.id,
        loanId: pendingDisbursement.loanId,
      });
    }
    return result;
  }

  // 5. Loan applications still in progress (standard loans).
  // Applications linked to an order are already covered by step 3.
  const activeApplication = await prisma.loanApplication.findFirst({
    where: {
      borrowerId,
      status: { in: ['PENDING_REVIEW', 'APPROVED', 'PENDING_DOCUMENTS'] },
      orders: { none: {} },
    },
    select: { id: true, status: true },
  });

  if (activeApplication) {
    const result = {
      isEligible: false,
      reason: 'You already have a loan application in progress.',
      activeFinancing: { type: 'LOAN' as const, id: activeApplication.id, status: activeApplication.status },
    };
    if (actorId) {
      await logBlockedAttempt(actorId, borrowerId, result.reason, { loanApplicationId: activeApplication.id });
    }
    return result;
  }

  return { isEligible: true };
}

/**
 * Quick check for whether a borrower currently has any active financing.
 */
export async function hasActiveFinancing(borrowerId: string): Promise<boolean> {
  const result = await validateBorrowerEligibility(borrowerId);
  return !result.isEligible;
}

async function logBlockedAttempt(actorId: string, borrowerId: string, reason: string, details?: any) {
  try {
    await createAuditLog({
      actorId,
      action: 'FINANCING_ATTEMPT_BLOCKED',
      entity: 'BORROWER',
      entityId: borrowerId,
      details: { reason, ...details },
    });
  } catch (error) {
    console.error('Failed to log blocked attempt:', error);
  }
}
