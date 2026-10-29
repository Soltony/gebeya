/**
 * The core banking (CBS) transfer call used for every affiliate money movement:
 * payouts and the transfers points pay for. CBS debits the account behind
 * `providerId` (the affiliate account's) and credits `creditAccount`.
 *
 * A request that fails or times out may still have been paid by the bank, so
 * callers never retry on their own: an admin checks with the bank first.
 */
import {
  auditExternalApiError,
  auditExternalApiRequest,
  auditExternalApiResponse,
  newAuditCorrelationId,
} from '@/lib/audit-log';

const CBS_TIMEOUT_MS = 60_000;

/** Provider id CBS debits when the affiliate account has none of its own configured. */
export function defaultCbsProviderId(): string {
  return process.env.AFFILIATE_PAYOUT_PROVIDER_ID || process.env.FORCE_PROVIDER_ID || 'PRO0002';
}

function cbsTarget() {
  const url = process.env.AFFILIATE_PAYOUT_URL || process.env.EXTERNAL_DISBURSEMENT_URL;
  const user = process.env.EXTERNAL_API_USERNAME;
  const pass = process.env.EXTERNAL_API_PASSWORD;
  const auth = user && pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : undefined;
  return { url, auth };
}

export type CbsTransferResult =
  | { ok: true; transactionId: string | null; statusCode: number; requestPayload: string; responsePayload: string | null }
  | { ok: false; message: string; statusCode: number | null; requestPayload: string; responsePayload: string | null };

export async function cbsTransfer(input: {
  creditAccount: string;
  amount: number;
  providerId: string;
  audit: { actorId: string; integration: string; entity: string; entityId: string };
}): Promise<CbsTransferResult> {
  const { url, auth } = cbsTarget();
  const body = { creditAccount: input.creditAccount, providerId: input.providerId, amount: input.amount };
  const requestPayload = JSON.stringify(body);
  if (!url) {
    return {
      ok: false,
      message: 'Missing EXTERNAL_DISBURSEMENT_URL (or AFFILIATE_PAYOUT_URL) env var',
      statusCode: null,
      requestPayload,
      responsePayload: null,
    };
  }

  const auditBase = { ...input.audit, correlationId: newAuditCorrelationId() };
  const headers = { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) };
  await auditExternalApiRequest(auditBase, { method: 'POST', url, headers, body }).catch(() => null);

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: requestPayload, signal: AbortSignal.timeout(CBS_TIMEOUT_MS) });
  } catch (error: any) {
    await auditExternalApiError(auditBase, error, { durationMs: Date.now() - startedAt }).catch(() => null);
    return {
      ok: false,
      message: `Request failed: ${String(error?.message ?? error)}. The bank may still have processed it; check before retrying.`,
      statusCode: null,
      requestPayload,
      responsePayload: null,
    };
  }

  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  await auditExternalApiResponse(auditBase, {
    status: res.status,
    statusText: res.statusText,
    body: parsed,
    durationMs: Date.now() - startedAt,
  }).catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      message: `The transfer service returned status ${res.status}.`,
      statusCode: res.status,
      requestPayload,
      responsePayload: text || null,
    };
  }
  const transactionId =
    parsed && typeof parsed === 'object' ? parsed.transactionId ?? parsed.transactionid ?? parsed.transaction_id ?? null : null;
  return {
    ok: true,
    transactionId: transactionId ? String(transactionId) : null,
    statusCode: res.status,
    requestPayload,
    responsePayload: text || null,
  };
}
