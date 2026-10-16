import type { AllocationBucket, ManualRepaymentPolicy } from '@/lib/manual-repayment';

export interface OutstandingBreakdown {
  principal: number;
  interest: number;
  serviceFee: number;
  penalty: number;
  tax: number;
  total: number;
  /** What a single repayment may settle now — the active installment, or the loan. */
  payableNow?: number;
  installmentNumber?: number | null;
}

export interface LoanSearchResult {
  loanId: string;
  borrowerId: string;
  customerName: string | null;
  telephone: string;
  accountNumber: string | null;
  productName: string | null;
  providerName: string | null;
  loanAmount: number;
  repaidAmount: number;
  disbursedDate: string;
  dueDate: string;
  repaymentStatus: string;
  outstanding: Required<OutstandingBreakdown>;
  pendingEntry: { amount: number; referenceNumber: string; submittedAt: string } | null;
}

export interface ManualRepaymentRow {
  id: string;
  loanId: string;
  borrowerId: string;
  amount: number;
  paymentSource: string;
  referenceNumber: string;
  paymentDate: string;
  remarks: string | null;
  status: string;
  installmentNumber: number | null;
  attachment: { name: string | null; type: string | null; size: number | null } | null;
  balanceBefore: OutstandingBreakdown;
  balanceAfter: number | null;
  loanStatusBefore: string;
  loanStatusAfter: string | null;
  allocation: Record<AllocationBucket, number> | null;
  maker: { id: string; fullName: string; email: string } | null;
  makerIp: string | null;
  checker: { id: string; fullName: string; email: string } | null;
  checkerIp: string | null;
  decidedAt: string | null;
  postedAt: string | null;
  rejectionReason: string | null;
  reversalReason: string | null;
  reversalRequestedById: string | null;
  reversalRequestedAt: string | null;
  reversedAt: string | null;
  createdAt: string;
  loan: {
    id: string;
    loanAmount: number;
    repaidAmount: number | null;
    repaymentStatus: string;
    dueDate: string;
    productName: string | null;
    providerName: string | null;
  } | null;
}

export interface AuditTrailEntry {
  id: string;
  action: string;
  actorId: string;
  actorName: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  details: Record<string, unknown> | string | null;
}

export interface ManualRepaymentListResponse {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  rows: ManualRepaymentRow[];
  summary: Record<string, { count: number; amount: number }>;
}

export type Policy = ManualRepaymentPolicy;
