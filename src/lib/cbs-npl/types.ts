// Types mirroring the CBS "Digital Loan Repayment" API surface:
//   POST   /api/v1/notification/bulk               — register accounts for monitoring
//   POST   /api/v1/notification/repay              — debit a monitored account
//   DELETE /api/v1/notification/delete/{account}   — stop monitoring an account
// plus the credit notification the CBS pushes to us when a monitored account
// receives a deposit.

export interface CbsBulkUploadRequest {
  accountNumbers: string[];
}

export interface CbsBulkUploadResponse {
  totalReceived: number;
  insertedCount: number;
  alreadyExistsCount: number;
}

export interface CbsCreditNotificationPayload {
  // Account number that received a credit / deposit.
  accountNumber: string;
  // Amount credited to the account.
  amount: number | string;
  // Current total balance on the account (after the credit).
  currentBalance?: number | string;
  // Minimum balance the account must retain.
  accountMinimumBalance?: number | string;
  // Account category/classification supplied by the CBS.
  accountCategory?: string;
  // Optional fields the CBS may include for traceability.
  correlationId?: string;
  externalReference?: string;
  providerId?: string;
  notifiedAt?: string;
  [key: string]: unknown;
}

export interface CbsRepayRequest {
  correlationId: string;
  accountNumber: string;
  amount: string | number;
  providerId: string;
}

export interface CbsRepayResponse {
  status: "Success" | "Failed" | string;
  message: string;
  status_code: number;
  transactionId: string | null;
  debitAmount: number | null;
  debitAccount: string | null;
  creditAccount: string | null;
  providerId: string | null;
}

export interface CbsDeleteResponse {
  // CBS may echo back a status/message; shape is intentionally loose since the
  // delete endpoint contract only specifies the account number in the path.
  status?: string;
  message?: string;
  status_code?: number;
  deletedCount?: number;
  [key: string]: unknown;
}

export interface CbsCallResult<T> {
  ok: boolean;
  status: number;
  data: T | undefined;
  requestBody: unknown;
  rawResponse: string | undefined;
  durationMs: number;
  error?: string;
}
