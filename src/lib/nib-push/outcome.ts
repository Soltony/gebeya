/**
 * Reads the bank's verdict out of a decrypted callback or status reply.
 *
 * statusCode 1 covers two different things: a real decline (wrong PIN, no
 * balance) and a switch failure after core banking already debited the
 * customer and credited us. The second is recognised by an FT number on the
 * failure (an FT on a failure contradicts itself) or by the fixed "server
 * busy" text, and is reported as PROCESSING so an operator confirms it
 * instead of the payment being recorded as failed.
 */

export type PushOutcome = 'SUCCESS' | 'FAILED' | 'PROCESSING' | 'PENDING';

export type PushResult = {
  outcome: PushOutcome;
  /** Our reference as the bank echoed it, when it did. */
  transactionRef: string | null;
  statusDesc: string | null;
  /** Core-banking FT number. */
  cbsReference: string | null;
  payerAccount: string | null;
  amount: number | null;
};

const SERVER_BUSY = /server\s*busy/i;

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function moneyMayHaveMoved(cbsReference: string | null, statusDesc: string | null) {
  return Boolean(cbsReference) || SERVER_BUSY.test(statusDesc ?? '');
}

/** Callback body: statusCode 0 = success, 1 = failed. Any other code leaves the payment open for the status check. */
export function readCallbackResult(body: Record<string, unknown>): PushResult {
  const statusDesc = text(body.statusDesc);
  const cbsReference = text(body.cbsreference ?? body.cbsReference);
  const code = text(body.statusCode);

  let outcome: PushOutcome = 'PENDING';
  if (code === '0') outcome = 'SUCCESS';
  else if (code === '1') outcome = moneyMayHaveMoved(cbsReference, statusDesc) ? 'PROCESSING' : 'FAILED';

  return {
    outcome,
    transactionRef: text(body.transactionRef),
    statusDesc,
    cbsReference,
    payerAccount: text(body.payerAccount),
    amount: amount(body.amount),
  };
}

export type PushDecision = { to: 'COMPLETED' | 'FAILED' | 'PROCESSING'; statusDesc: string | null } | null;

const MONEY_TOLERANCE = 0.01;

/**
 * Where a bank result moves an attempt that is currently `current`, or null
 * for no change. COMPLETED never changes again, and nothing that may mean
 * money moved is ever recorded as FAILED:
 * - success on an attempt already marked FAILED, or for a different amount,
 *   goes to PROCESSING for an operator;
 * - a failure on a PROCESSING attempt leaves it for the operator.
 * With `manual` (an FT an operator found on the bank statement and a second
 * user approved), success completes any attempt that is not yet COMPLETED.
 */
export function decideTransition(
  current: string,
  result: PushResult,
  expectedAmount: number,
  { manual = false }: { manual?: boolean } = {},
): PushDecision {
  const open = current === 'PENDING' || current === 'AWAITING_PIN';
  let decision: PushDecision = null;

  switch (result.outcome) {
    case 'SUCCESS':
      if (manual) {
        decision = { to: 'COMPLETED', statusDesc: result.statusDesc };
      } else if (current === 'FAILED') {
        decision = { to: 'PROCESSING', statusDesc: 'Bank reported success after the payment was marked failed.' };
      } else if (open || current === 'PROCESSING') {
        decision =
          result.amount !== null && Math.abs(result.amount - expectedAmount) > MONEY_TOLERANCE
            ? { to: 'PROCESSING', statusDesc: `Bank reported ${result.amount} paid; ${expectedAmount} was requested.` }
            : { to: 'COMPLETED', statusDesc: result.statusDesc };
      }
      break;
    case 'FAILED':
      if (open) decision = { to: 'FAILED', statusDesc: result.statusDesc };
      break;
    case 'PROCESSING':
      if (open || current === 'FAILED') decision = { to: 'PROCESSING', statusDesc: result.statusDesc };
      break;
  }

  return decision && decision.to !== current ? decision : null;
}

/** Status reply: paymentStatus is PAID, NOT_PAID or PENDING. */
export function readStatusResult(body: Record<string, unknown>): PushResult {
  const statusDesc = text(body.message) ?? text(body.statusDesc);
  const cbsReference = text(body.cbsreference ?? body.cbsReference);
  const status = text(body.paymentStatus)?.toUpperCase();

  let outcome: PushOutcome = 'PENDING';
  if (status === 'PAID') outcome = 'SUCCESS';
  else if (status === 'NOT_PAID') outcome = moneyMayHaveMoved(cbsReference, statusDesc) ? 'PROCESSING' : 'FAILED';

  return {
    outcome,
    transactionRef: text(body.transactionRef) ?? text(body.transactionId),
    statusDesc,
    cbsReference,
    payerAccount: text(body.payerAccount),
    amount: amount(body.amount),
  };
}
