/**
 * Wire shape for a manual repayment. Shared by the list, detail and approval
 * endpoints so every screen reads the same field names, and kept out of the route
 * files because a Next.js `route.ts` may only export HTTP handlers.
 */

import type { Prisma } from '@prisma/client';
import { MANUAL_REPAYMENT_STATUSES } from './manual-repayment';

export const MANUAL_REPAYMENT_INCLUDE = {
  maker: { select: { id: true, fullName: true, email: true } },
  checker: { select: { id: true, fullName: true, email: true } },
  loan: {
    select: {
      id: true,
      loanAmount: true,
      repaidAmount: true,
      repaymentStatus: true,
      dueDate: true,
      product: { select: { name: true, provider: { select: { name: true } } } },
    },
  },
} satisfies Prisma.ManualRepaymentInclude;

export type ManualRepaymentWithRelations = Prisma.ManualRepaymentGetPayload<{
  include: typeof MANUAL_REPAYMENT_INCLUDE;
}>;

export type SerializedManualRepayment = ReturnType<typeof serializeManualRepayment>;

export function serializeManualRepayment(row: ManualRepaymentWithRelations) {
  return {
    id: row.id,
    loanId: row.loanId,
    borrowerId: row.borrowerId,
    amount: row.amount,
    paymentSource: row.paymentSource,
    referenceNumber: row.referenceNumber,
    paymentDate: row.paymentDate.toISOString(),
    remarks: row.remarks,
    status: row.status,
    installmentNumber: row.installmentNumber,
    attachment: row.attachmentName
      ? { name: row.attachmentName, type: row.attachmentType, size: row.attachmentSize }
      : null,
    balanceBefore: {
      principal: row.principalBefore,
      interest: row.interestBefore,
      serviceFee: row.serviceFeeBefore,
      penalty: row.penaltyBefore,
      tax: row.taxBefore,
      total: row.balanceBefore,
    },
    balanceAfter: row.balanceAfter,
    loanStatusBefore: row.loanStatusBefore,
    loanStatusAfter: row.loanStatusAfter,
    allocation: safeParse(row.allocation),
    maker: row.maker,
    makerIp: row.makerIp,
    checker: row.checker,
    checkerIp: row.checkerIp,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    postedAt: row.postedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    reversalReason: row.reversalReason,
    reversalRequestedById: row.reversalRequestedById,
    reversalRequestedAt: row.reversalRequestedAt?.toISOString() ?? null,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    loan: row.loan
      ? {
          id: row.loan.id,
          loanAmount: row.loan.loanAmount,
          repaidAmount: row.loan.repaidAmount,
          repaymentStatus: row.loan.repaymentStatus,
          dueDate: row.loan.dueDate.toISOString(),
          productName: row.loan.product?.name ?? null,
          providerName: row.loan.product?.provider?.name ?? null,
        }
      : null,
  };
}

export type StatusSummary = Record<string, { count: number; amount: number }>;

export function emptyStatusSummary(): StatusSummary {
  return Object.fromEntries(MANUAL_REPAYMENT_STATUSES.map((s) => [s, { count: 0, amount: 0 }]));
}

function safeParse(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
