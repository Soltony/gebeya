/**
 * NIB USSD push payments for direct (non-credit) orders.
 *
 * Follows NIB's Push Payment Integration Guide v1.0. The transfer call only
 * sends the PIN prompt to the customer's phone; the result arrives later as
 * an encrypted callback (/api/nib-push/callback), or from the status endpoint
 * when the callback is late. Each attempt is a DirectPendingPayment row with
 * method USSD_PUSH, so the Direct Payments report covers both payment methods.
 *
 *   PENDING ──200──► AWAITING_PIN ──callback / status──► COMPLETED | FAILED | PROCESSING
 *      └──── 4xx ──► FAILED
 *
 * PENDING stays open when the transfer got no answer, a 409 or a 5xx: the
 * request may still have been taken (§8.1, §8.2), so only the status endpoint
 * can close it. PROCESSING means the bank reported a failure that may still
 * have moved money (see ./outcome).
 */
import { randomBytes } from 'crypto';
import { Prisma, type DirectPendingPayment } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
  auditExternalApiError,
  auditExternalApiRequest,
  auditExternalApiResponse,
  createAuditLog,
  newAuditCorrelationId,
} from '@/lib/audit-log';
import { getNibPushConfig, getServerPrivateKey, NibPushConfigError } from './config';
import {
  forgetProviderPublicKey,
  getProviderPublicKey,
  getTransferStatus,
  isNibPushServiceDown,
  knownBankPublicKeys,
  NIB_PUSH_PATHS,
  NibPushHttpError,
  NibPushNetworkError,
  NibPushUnavailableError,
  postTransfer,
  type NibPushResponse,
} from './client';
import {
  deriveSharedSecret,
  encryptRequest,
  NibPushCryptoError,
  openEnvelope,
  samePublicKey,
  type ChecksumMode,
  type RequestEnvelope,
} from './crypto';
import { decideTransition, readCallbackResult, readStatusResult, type PushResult } from './outcome';

export const PUSH_METHOD = 'USSD_PUSH';

export const PushStatus = {
  PENDING: 'PENDING',
  AWAITING_PIN: 'AWAITING_PIN',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  PROCESSING: 'PROCESSING',
} as const;

/** The customer has not answered the prompt yet. */
export const OPEN_PUSH_STATUSES: string[] = [PushStatus.PENDING, PushStatus.AWAITING_PIN];
/** Statuses the bank's status endpoint can still change. */
const CHECKABLE_STATUSES: string[] = [...OPEN_PUSH_STATUSES, PushStatus.PROCESSING];

const INTEGRATION = 'NIB_PUSH_PAYMENT';
// The bank's status endpoint is asked at most this often per attempt, and not
// before the attempt is this old (the callback usually arrives first).
const STATUS_CHECK_INTERVAL_MS = 10_000;
// After a few minutes the customer has answered the prompt one way or the
// other, so the bank is asked less often.
const STATUS_CHECK_SLOW_AFTER_MS = 5 * 60 * 1000;
const STATUS_CHECK_SLOW_INTERVAL_MS = 60_000;
const RECONCILE_MIN_AGE_MS = 30 * 60 * 1000;
const RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECONCILE_BATCH = 200;
const STATUS_DESC_MAX = 500;
// A confirmed payment marks the order delivered from these, as gateway payments do.
const PAYABLE_ORDER_STATUSES = ['ON_DELIVERY', 'PENDING_MERCHANT_CONFIRMATION'];

const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** "ref" + 9 random characters, the reference format agreed with the provider. */
export function newTransactionRef(): string {
  return 'ref' + Array.from(randomBytes(9), b => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

function clip(value: string | null | undefined): string | null {
  return value ? value.slice(0, STATUS_DESC_MAX) : null;
}

/** Phone and account numbers are masked in logs: 2519****6017. */
function mask(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The status the bank meant. UAT reports some errors as HTTP 200 with the
 * real code in the body, e.g. { "statusCode": 401, "details": "Invalid Credentials" },
 * so an HTTP 200 alone does not mean the prompt was sent.
 */
export function effectiveStatus(res: Pick<NibPushResponse, 'status' | 'body'>): number {
  const code = Number((res.body as { statusCode?: unknown } | null)?.statusCode);
  const httpOk = res.status >= 200 && res.status < 300;
  return httpOk && Number.isInteger(code) && code >= 100 && code < 600 ? code : res.status;
}

/**
 * "This reference does not exist" from the status endpoint: 404 per the guide
 * (§9). UAT answers every reference, including paid ones, with 401 and an
 * empty unencrypted status body, so that reply says nothing about the
 * payment and must not be read as "no record".
 */
export function isNoRecordReply(res: Pick<NibPushResponse, 'status' | 'body'>): boolean {
  return res.status === 404;
}

/** The specific reason first: a 400 reads { message: "Unable to accept request", details: "User not found" }. */
function providerMessage(body: unknown): string | null {
  if (typeof body === 'string') return body.trim().slice(0, 200) || null;
  if (body && typeof body === 'object') {
    for (const key of ['error', 'details', 'detail', 'message']) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Starting a push
// ---------------------------------------------------------------------------

export type StartPushInput = {
  orderId: string;
  borrowerId: string;
  merchantId: string;
  amount: number;
  /** 251XXXXXXXXX; receives the PIN prompt. */
  customerPhone: string;
  /** Account to credit (§10.3 dynamic routing), or null for the account on our bank profile. */
  creditAccount: string | null;
  /** Both shown to the customer on the USSD screen. */
  merchantName: string;
  description: string;
  request?: { ipAddress?: string; userAgent?: string };
};

export type StartPushResult =
  | { status: 'AWAITING_PIN'; transactionRef: string }
  /** The bank did not answer, so the prompt may or may not have gone out. */
  | { status: 'PENDING'; transactionRef: string }
  | { status: 'FAILED'; transactionRef: string; message: string };

type AuditBase = Parameters<typeof auditExternalApiRequest>[0];

async function sealTransfer(payload: Record<string, unknown>, checksum: ChecksumMode) {
  const { key, fromCache } = await getProviderPublicKey();
  try {
    const sealed = encryptRequest(payload, key, checksum);
    return {
      envelope: sealed.envelope,
      keyFromCache: fromCache,
      // What decrypts the bank's replies for this attempt.
      keys: { sharedSecret: sealed.sharedSecret.toString('base64'), clientPrivateKey: sealed.clientPrivateKey.toString('base64') },
    };
  } catch (error) {
    if (error instanceof NibPushCryptoError) forgetProviderPublicKey();
    throw error;
  }
}

/** Null when the bank did not answer. */
async function sendTransfer(envelope: RequestEnvelope, audit: AuditBase, auditedPayload: unknown): Promise<NibPushResponse | null> {
  const base = { ...audit, correlationId: newAuditCorrelationId() };
  const request = { method: 'POST', url: `${getNibPushConfig().baseUrl}${NIB_PUSH_PATHS.transfer}`, body: auditedPayload };
  await auditExternalApiRequest(base, request).catch(() => null);

  const startedAt = Date.now();
  try {
    const res = await postTransfer(envelope);
    await auditExternalApiResponse(base, { status: res.status, body: res.body, durationMs: res.durationMs }).catch(() => null);
    return res;
  } catch (error) {
    if (!(error instanceof NibPushNetworkError)) throw error;
    console.error('[nib-push] transfer got no response', { orderId: audit.entityId, error: error.message });
    await auditExternalApiError(base, error, { durationMs: Date.now() - startedAt, request }).catch(() => null);
    return null;
  }
}

/**
 * Sends a PIN prompt to the customer's phone for `amount`. Throws
 * NibPushNetworkError / NibPushHttpError / NibPushCryptoError when the bank's
 * public key cannot be used, before anything is recorded.
 */
export async function startPushPayment(input: StartPushInput): Promise<StartPushResult> {
  const config = getNibPushConfig();
  // Nothing recorded and no prompt promised while the bank is not answering.
  if (isNibPushServiceDown('push')) throw new NibPushUnavailableError('The push service did not answer a recent call.');
  const transactionRef = newTransactionRef();
  const amount = Math.round(input.amount * 100) / 100;

  // Inner payload per §5.3.1.
  const payload: Record<string, unknown> = {
    customerPhone: input.customerPhone,
    amount,
    transactionRef,
    merchantName: input.merchantName,
    description: input.description,
    company: config.company,
  };
  if (input.creditAccount) payload.creditAccount = input.creditAccount;
  // Nothing else: the bank validates this against a strict schema (§5.3.1)
  // and rejects any other field, so the callback URL is registered with the
  // bank instead (§10.1) rather than sent per request.

  let sealed = await sealTransfer(payload, config.checksum);

  // Stored before sending: the callback can arrive before the transfer call returns.
  await prisma.directPendingPayment.create({
    data: {
      transactionId: transactionRef,
      orderId: input.orderId,
      borrowerId: input.borrowerId,
      merchantId: input.merchantId,
      amount,
      status: PushStatus.PENDING,
      method: PUSH_METHOD,
      customerPhone: input.customerPhone,
      ...sealed.keys,
    },
  });

  await createAuditLog({
    actorId: input.borrowerId,
    action: 'DIRECT_PAYMENT_PUSH_REQUEST',
    entity: 'ORDER',
    entityId: input.orderId,
    details: { transactionRef, amount, merchantId: input.merchantId, customerPhone: mask(input.customerPhone) },
  });

  const audit: AuditBase = {
    actorId: input.borrowerId,
    ipAddress: input.request?.ipAddress,
    userAgent: input.request?.userAgent,
    integration: INTEGRATION,
    entity: 'ORDER',
    entityId: input.orderId,
  };
  const auditedPayload = { ...payload, customerPhone: mask(input.customerPhone), creditAccount: mask(input.creditAccount) ?? undefined };

  let res = await sendTransfer(sealed.envelope, audit, auditedPayload);
  if (res && effectiveStatus(res) === 401) {
    forgetProviderPublicKey();
    if (sealed.keyFromCache) {
      // A rotated key or credential (§2.2). A 401 means the request was not
      // accepted, so it is safe to send once more under a fresh key.
      try {
        sealed = await sealTransfer(payload, config.checksum);
        await prisma.directPendingPayment.update({ where: { transactionId: transactionRef }, data: sealed.keys });
      } catch (error) {
        await markStartFailed(input, transactionRef, 'Could not get a new key from the bank.', 401);
        throw error;
      }
      res = await sendTransfer(sealed.envelope, audit, auditedPayload);
    }
  }

  // No answer, "duplicate reference" or a server fault: the bank may still
  // have taken the request, so the status endpoint decides (§8.1, §8.2).
  const leaveOpen = async (answer: string): Promise<StartPushResult> => {
    await prisma.directPendingPayment.updateMany({
      where: { transactionId: transactionRef, status: PushStatus.PENDING },
      data: { statusDesc: clip(`Transfer request got ${answer}; waiting for the status check.`) },
    });
    return { status: 'PENDING', transactionRef };
  };
  if (!res) return leaveOpen('no response');

  const status = effectiveStatus(res);
  const message = providerMessage(res.body);
  if (status === 409 || status >= 500) return leaveOpen(`status ${status}${message ? ` (${message})` : ''}`);

  if (status >= 200 && status < 300) {
    await prisma.directPendingPayment.updateMany({
      where: { transactionId: transactionRef, status: PushStatus.PENDING },
      data: { status: PushStatus.AWAITING_PIN, statusDesc: clip(message) },
    });
    return { status: 'AWAITING_PIN', transactionRef };
  }

  const reason = message ?? `The bank rejected the request (status ${status}).`;
  await markStartFailed(input, transactionRef, reason, status);
  return { status: 'FAILED', transactionRef, message: reason };
}

async function markStartFailed(input: StartPushInput, transactionRef: string, message: string, httpStatus: number) {
  await prisma.directPendingPayment.updateMany({
    where: { transactionId: transactionRef, status: PushStatus.PENDING },
    data: { status: PushStatus.FAILED, statusDesc: clip(message) },
  });
  await createAuditLog({
    actorId: input.borrowerId,
    action: 'DIRECT_PAYMENT_FAILED',
    entity: 'ORDER',
    entityId: input.orderId,
    details: { method: PUSH_METHOD, transactionRef, httpStatus, statusDesc: message, source: 'TRANSFER' },
  });
}

// ---------------------------------------------------------------------------
// Applying the bank's result
// ---------------------------------------------------------------------------

export type PushTransition = {
  attemptId: string;
  /** USSD_PUSH, or GATEWAY for a super-app payment resolved by hand. */
  method: string;
  transactionRef: string;
  orderId: string;
  borrowerId: string;
  merchantId: string;
  amount: number;
  from: string;
  to: 'COMPLETED' | 'FAILED' | 'PROCESSING';
  statusDesc: string | null;
  cbsReference: string | null;
  /** The payment moved the order to DELIVERED. */
  orderDelivered: boolean;
  /** Money arrived that the order did not need; operations refund it. */
  needsRefund: 'DUPLICATE_PAYMENT' | 'ORDER_CANCELLED' | null;
};

type ResultSource = 'CALLBACK' | 'STATUS' | 'MANUAL';

export class FtConflictError extends Error {}

/** Ties an FT to this attempt; an FT can settle only one payment. */
async function recordFt(tx: Prisma.TransactionClient, cbsReference: string, attemptId: string) {
  const byFt = await tx.directPaymentFt.findUnique({ where: { cbsReference } });
  if (byFt) {
    if (byFt.directPendingPaymentId === attemptId) return;
    throw new FtConflictError(`FT ${cbsReference} is already recorded on another payment.`);
  }
  const own = await tx.directPaymentFt.findUnique({ where: { directPendingPaymentId: attemptId } });
  if (own) throw new FtConflictError(`Bank reported FT ${cbsReference}, but FT ${own.cbsReference} is already recorded on this payment.`);

  try {
    await tx.directPaymentFt.create({ data: { cbsReference, directPendingPaymentId: attemptId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new FtConflictError(`FT ${cbsReference} is already recorded on another payment.`);
    }
    throw error;
  }
}

function transitionFrom(
  attempt: DirectPendingPayment,
  to: PushTransition['to'],
  statusDesc: string | null,
  cbsReference: string | null,
): PushTransition {
  return {
    attemptId: attempt.id,
    method: attempt.method,
    transactionRef: attempt.transactionId,
    orderId: attempt.orderId,
    borrowerId: attempt.borrowerId,
    merchantId: attempt.merchantId,
    amount: attempt.amount,
    from: attempt.status,
    to,
    statusDesc,
    cbsReference,
    orderDelivered: false,
    needsRefund: null,
  };
}

async function applyOnce(attemptId: string, result: PushResult, manual = false): Promise<PushTransition | null | 'RACED'> {
  return prisma.$transaction(async tx => {
    const attempt = await tx.directPendingPayment.findUnique({ where: { id: attemptId } });
    if (!attempt) return null;
    const decision = decideTransition(attempt.status, result, attempt.amount, { manual });
    if (!decision) return null;

    // Conditional on the status just read, so concurrent callbacks and status
    // checks cannot both apply a result.
    const claim = await tx.directPendingPayment.updateMany({
      where: { id: attempt.id, status: attempt.status },
      data: {
        status: decision.to,
        statusDesc: clip(decision.statusDesc),
        payerAccount: result.payerAccount ?? undefined,
        completedAt: decision.to === PushStatus.COMPLETED ? new Date() : undefined,
      },
    });
    if (claim.count === 0) return 'RACED';

    // A failure's FT is still evidence money moved, so it is recorded (and reserved) too.
    if (result.cbsReference && decision.to !== PushStatus.FAILED) await recordFt(tx, result.cbsReference, attempt.id);

    const transition = transitionFrom(attempt, decision.to, clip(decision.statusDesc), result.cbsReference);
    if (decision.to === PushStatus.COMPLETED) {
      const delivered = await tx.order.updateMany({
        where: { id: attempt.orderId, status: { in: PAYABLE_ORDER_STATUSES } },
        data: { status: 'DELIVERED' },
      });
      transition.orderDelivered = delivered.count > 0;

      const otherPayments = await tx.directPendingPayment.count({
        where: { orderId: attempt.orderId, status: PushStatus.COMPLETED, id: { not: attempt.id } },
      });
      if (otherPayments > 0) {
        transition.needsRefund = 'DUPLICATE_PAYMENT';
      } else if (!transition.orderDelivered) {
        const order = await tx.order.findUnique({ where: { id: attempt.orderId }, select: { status: true } });
        if (order?.status === 'CANCELLED') transition.needsRefund = 'ORDER_CANCELLED';
      }
    }
    return transition;
  });
}

/** An FT clash keeps the money question open: the attempt goes to PROCESSING for an operator. */
async function holdForFtConflict(attemptId: string, message: string, cbsReference: string | null): Promise<PushTransition | null> {
  const attempt = await prisma.directPendingPayment.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.status === PushStatus.COMPLETED) return null;
  const alreadyProcessing = attempt.status === PushStatus.PROCESSING;
  const claim = await prisma.directPendingPayment.updateMany({
    where: { id: attempt.id, status: attempt.status },
    data: { status: PushStatus.PROCESSING, statusDesc: clip(message) },
  });
  if (claim.count === 0 || alreadyProcessing) return null;
  return transitionFrom(attempt, PushStatus.PROCESSING, clip(message), cbsReference);
}

async function auditTransition(t: PushTransition, result: PushResult, source: ResultSource, extra: Record<string, unknown> = {}) {
  const details = {
    method: t.method,
    transactionRef: t.transactionRef,
    from: t.from,
    to: t.to,
    amount: t.amount,
    paidAmount: result.amount,
    cbsReference: t.cbsReference,
    statusDesc: t.statusDesc,
    payerAccount: mask(result.payerAccount),
    merchantId: t.merchantId,
    orderDelivered: t.orderDelivered,
    source,
    ...extra,
  };
  const action =
    t.to === PushStatus.COMPLETED ? 'DIRECT_PAYMENT_SUCCESS' : t.to === PushStatus.FAILED ? 'DIRECT_PAYMENT_FAILED' : 'DIRECT_PAYMENT_NEEDS_REVIEW';
  await createAuditLog({ actorId: t.borrowerId, action, entity: 'ORDER', entityId: t.orderId, details });

  if (t.to === PushStatus.PROCESSING) {
    console.warn('[nib-push] payment needs review', { orderId: t.orderId, transactionRef: t.transactionRef, statusDesc: t.statusDesc });
  }
  if (t.needsRefund) {
    console.error('[nib-push] payment received that the order did not need', {
      orderId: t.orderId,
      transactionRef: t.transactionRef,
      reason: t.needsRefund,
    });
    await createAuditLog({
      actorId: t.borrowerId,
      action: 'DIRECT_PAYMENT_NEEDS_REFUND',
      entity: 'ORDER',
      entityId: t.orderId,
      details: { ...details, reason: t.needsRefund },
    });
  }
}

/**
 * Records the bank's result for an attempt and, on success, marks the order
 * delivered — all in one transaction. Returns what changed, or null when the
 * result changes nothing (duplicates, results for final attempts).
 */
export async function applyPushOutcome(attemptId: string, result: PushResult, source: ResultSource): Promise<PushTransition | null> {
  let transition: PushTransition | null = null;
  try {
    // Re-read and retry when a concurrent result changed the status first, so
    // e.g. a success arriving just after a failure still lands (as PROCESSING).
    for (let tries = 0; tries < 3; tries++) {
      const applied = await applyOnce(attemptId, result);
      if (applied === 'RACED') continue;
      transition = applied;
      break;
    }
  } catch (error) {
    if (!(error instanceof FtConflictError)) throw error;
    transition = await holdForFtConflict(attemptId, error.message, result.cbsReference);
  }

  if (transition) await auditTransition(transition, result, source);
  return transition;
}

/**
 * Settles a direct payment by hand: an operator found its FT on the bank
 * statement and a second user approved it (DirectPaymentResolve in
 * /api/approvals). Same effects as a bank confirmation, from any status but
 * COMPLETED. Returns null when the attempt was already paid while the request
 * waited; throws FtConflictError when the FT already settled another payment.
 */
export async function resolvePushPaymentManually(attemptId: string, cbsReference: string, actorId: string): Promise<PushTransition | null> {
  const result: PushResult = {
    outcome: 'SUCCESS',
    transactionRef: null,
    statusDesc: `Confirmed from the bank statement (FT ${cbsReference}).`,
    cbsReference,
    payerAccount: null,
    amount: null,
  };
  let transition: PushTransition | null = null;
  for (let tries = 0; tries < 3; tries++) {
    const applied = await applyOnce(attemptId, result, true);
    if (applied === 'RACED') continue;
    transition = applied;
    break;
  }
  if (transition) await auditTransition(transition, result, 'MANUAL', { resolvedBy: actorId });
  return transition;
}

// ---------------------------------------------------------------------------
// Status checks (customer polling and background reconciliation)
// ---------------------------------------------------------------------------

type AttemptKeys = Pick<DirectPendingPayment, 'sharedSecret' | 'clientPrivateKey'>;

/**
 * A key that may open a bank message. `fromBank` marks keys nobody but the
 * bank could also hold: the secret agreed with the bank's key when the request
 * was sent, or a derivation with a known bank public key. A key derived with
 * any other `pubkey` proves nothing: anyone who knows our public key (it is
 * public, and one-time keys cross the wire) can encrypt to it.
 */
type CandidateKey = { key: Buffer; fromBank: boolean };

function isBankKey(publicKey: string | null, bankKeys: string[]): boolean {
  return Boolean(publicKey) && bankKeys.some(known => samePublicKey(known, publicKey!));
}

function derive(privateKey: Buffer, peerPublicKey: string): Buffer | null {
  try {
    return deriveSharedSecret(privateKey, peerPublicKey);
  } catch (error) {
    if (error instanceof NibPushCryptoError) return null;
    throw error;
  }
}

/**
 * Keys that may open the bank's replies for an attempt: the secret agreed
 * when the request was sent, then our one-time private key with the envelope's
 * `pubkey` (§6.2). Untrusted derivations are skipped unless `allowUntrusted`.
 */
function attemptKeys(attempt: AttemptKeys, peerPublicKey: string | null, bankKeys: string[], allowUntrusted = true): CandidateKey[] {
  const keys: CandidateKey[] = [];
  if (attempt.sharedSecret) keys.push({ key: Buffer.from(attempt.sharedSecret, 'base64'), fromBank: true });
  const fromBank = isBankKey(peerPublicKey, bankKeys);
  if (attempt.clientPrivateKey && peerPublicKey && (fromBank || allowUntrusted)) {
    const key = derive(Buffer.from(attempt.clientPrivateKey, 'base64'), peerPublicKey);
    if (key) keys.push({ key, fromBank });
  }
  return keys;
}

const checkableSelect = {
  id: true,
  transactionId: true,
  method: true,
  status: true,
  sharedSecret: true,
  clientPrivateKey: true,
  createdAt: true,
} as const;

type CheckableAttempt = Pick<DirectPendingPayment, keyof typeof checkableSelect>;

/** The `select` callers use to load attempts for refreshPushStatus. */
export const PUSH_STATUS_CHECK_SELECT = checkableSelect;

const NO_RECORD: PushResult = {
  outcome: 'FAILED',
  transactionRef: null,
  statusDesc: 'The bank has no record of this payment request.',
  cbsReference: null,
  payerAccount: null,
  amount: null,
};

// Last unusable status-check outcome per attempt (in this process): an HTTP
// status, or "timeout". UAT's status endpoint answers 401 for every reference
// and its gateway has had long outages, so a repeated outcome is logged once
// and the attempt is asked about less often.
const unusableStatusReplies = new Map<string, number | 'timeout'>();

function noteUnusableStatusCheck(transactionRef: string, outcome: number | 'timeout', details: Record<string, unknown>) {
  if (unusableStatusReplies.get(transactionRef) === outcome) return;
  if (unusableStatusReplies.size > 1000) unusableStatusReplies.clear();
  unusableStatusReplies.set(transactionRef, outcome);
  console.warn('[nib-push] status check returned no result; repeats of this outcome are not logged', { transactionRef, ...details });
}

function noteUnusableStatusReply(transactionRef: string, res: NibPushResponse) {
  const status = effectiveStatus(res);
  noteUnusableStatusCheck(transactionRef, status, { httpStatus: res.status, status, message: providerMessage(res.body) });
}

/**
 * Asks the bank's status endpoint about an attempt and applies the answer.
 * Best-effort: never throws for bank or network problems, and asks at most
 * once every 10 seconds per attempt across all instances (every minute once
 * the attempt is 5 minutes old, or once the endpoint gave it an unusable reply).
 */
export async function refreshPushStatus(attempt: CheckableAttempt, now = new Date()): Promise<PushTransition | null> {
  if (attempt.method !== PUSH_METHOD || !CHECKABLE_STATUSES.includes(attempt.status)) return null;
  if (!attempt.sharedSecret && !attempt.clientPrivateKey) return null;
  const age = now.getTime() - attempt.createdAt.getTime();
  if (age < STATUS_CHECK_INTERVAL_MS) return null;
  const slow = age >= STATUS_CHECK_SLOW_AFTER_MS || unusableStatusReplies.has(attempt.transactionId);
  const interval = slow ? STATUS_CHECK_SLOW_INTERVAL_MS : STATUS_CHECK_INTERVAL_MS;

  const claim = await prisma.directPendingPayment.updateMany({
    where: {
      id: attempt.id,
      status: { in: CHECKABLE_STATUSES },
      OR: [{ statusCheckedAt: null }, { statusCheckedAt: { lt: new Date(now.getTime() - interval) } }],
    },
    data: { statusCheckedAt: now },
  });
  if (claim.count === 0) return null;

  try {
    const res = await getTransferStatus(attempt.transactionId);
    if (isNoRecordReply(res)) {
      // A request we never saw accepted never reached the bank, so the
      // customer can try again. An accepted one is left for the bank to settle.
      if (attempt.status === PushStatus.PENDING) return await applyPushOutcome(attempt.id, NO_RECORD, 'STATUS');
      console.warn('[nib-push] bank has no record of an accepted transfer', { transactionRef: attempt.transactionId, status: attempt.status });
      return null;
    }
    if (effectiveStatus(res) !== 200 || !res.body || typeof res.body !== 'object') {
      noteUnusableStatusReply(attempt.transactionId, res);
      return null;
    }
    unusableStatusReplies.delete(attempt.transactionId);
    // A reply to our own request: which key opens it is all that matters.
    const envelope = res.body as Record<string, unknown>;
    const { body } = openEnvelope(envelope, attemptKeys(attempt, str(envelope.pubkey), []).map(c => c.key));
    const result = readStatusResult(body);
    if (result.transactionRef && result.transactionRef !== attempt.transactionId) {
      console.warn('[nib-push] status reply is for a different transaction', { transactionRef: attempt.transactionId });
      return null;
    }
    return await applyPushOutcome(attempt.id, result, 'STATUS');
  } catch (error) {
    // Skipped because the bank is not answering: the next check after it recovers will tell.
    if (error instanceof NibPushUnavailableError) return null;
    if (error instanceof NibPushNetworkError) {
      noteUnusableStatusCheck(attempt.transactionId, 'timeout', { error: error.message });
      return null;
    }
    if (error instanceof NibPushHttpError || error instanceof NibPushCryptoError || error instanceof NibPushConfigError) {
      console.warn('[nib-push] status check failed', { transactionRef: attempt.transactionId, error: error.message });
      return null;
    }
    throw error;
  }
}

/**
 * Background reconciliation: attempts still open (or PROCESSING) 30 minutes
 * to 24 hours after they started are checked against the status endpoint.
 * PAID settles them, NOT_PAID fails them, PENDING leaves them alone.
 */
export async function reconcilePushPaymentsOnce(now = new Date()) {
  const attempts = await prisma.directPendingPayment.findMany({
    where: {
      method: PUSH_METHOD,
      status: { in: CHECKABLE_STATUSES },
      createdAt: { gte: new Date(now.getTime() - RECONCILE_MAX_AGE_MS), lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
    },
    select: checkableSelect,
    orderBy: { createdAt: 'asc' },
    take: RECONCILE_BATCH,
  });

  const transitions: PushTransition[] = [];
  for (const attempt of attempts) {
    const transition = await refreshPushStatus(attempt, now);
    if (transition) transitions.push(transition);
  }
  return { scanned: attempts.length, transitions };
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export type PushCallbackResponse = { status: number; message: string; transition: PushTransition | null };

async function findPushAttempt(transactionRef: string) {
  const attempt = await prisma.directPendingPayment.findUnique({ where: { transactionId: transactionRef } });
  return attempt?.method === PUSH_METHOD ? attempt : null;
}

/** Keeps a copy of each callback in PaymentTransaction, as the gateway callback does. */
async function logCallback(transactionRef: string, body: Record<string, unknown>, status: 'RECEIVED' | 'PROCESSED') {
  try {
    const cbsReference = typeof body.cbsreference === 'string' ? body.cbsreference : null;
    const payload = JSON.stringify({ ...body, payerAccount: mask(typeof body.payerAccount === 'string' ? body.payerAccount : null) });
    await prisma.paymentTransaction.upsert({
      where: { transactionId: transactionRef },
      create: { transactionId: transactionRef, txnRef: cbsReference, paymentType: 'DIRECT', status, payload },
      update: { txnRef: cbsReference, status, payload },
    });
  } catch (error) {
    console.error('[nib-push] failed to log callback', { transactionRef, error: String(error) });
  }
}

const CALLBACK_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const CALLBACK_SCAN_LIMIT = 500;

class UnknownReferenceError extends Error {}

type KeyCandidate = CandidateKey & { attempt: DirectPendingPayment | null };

function openWith(envelope: Record<string, unknown>, candidates: KeyCandidate[]) {
  const { body, keyIndex } = openEnvelope(envelope, candidates.map(c => c.key));
  return { body, attempt: candidates[keyIndex].attempt, fromBank: candidates[keyIndex].fromBank };
}

/** Bank keys to recognise callbacks by; asks get-pub-key only when none is known yet and it is answering. */
async function bankPublicKeys(): Promise<string[]> {
  const known = knownBankPublicKeys();
  if (known.length > 0 || isNibPushServiceDown('key')) return known;
  try {
    return [(await getProviderPublicKey()).key];
  } catch {
    return [];
  }
}

/**
 * Finds the key that opens a callback. Per the guide the envelope carries no
 * reference in clear and is encrypted between the bank's `pubkey` and the
 * public key we registered with them (§7.3, §10.2), i.e. our server key. If
 * that does not open it, the keys of the last day's attempts are tried, in
 * case the bank used an attempt's one-time key; GCM lets only the right key
 * through, so a match also identifies the attempt. Without valid Basic auth
 * only keys that prove the bank sent it are tried.
 */
async function openCallback(envelope: Record<string, unknown>, authenticated: boolean) {
  const outerRef = str(envelope.transactionRef);
  const peerKey = str(envelope.pubkey);
  const bankKeys = await bankPublicKeys();
  const candidates: KeyCandidate[] = [];
  const keysOf = (attempt: DirectPendingPayment) =>
    attemptKeys(attempt, peerKey, bankKeys, authenticated).map(key => ({ ...key, attempt }));

  if (outerRef) {
    const attempt = await findPushAttempt(outerRef);
    if (!attempt) throw new UnknownReferenceError();
    candidates.push(...keysOf(attempt));
  }
  const serverKey = getServerPrivateKey();
  const peerIsBank = isBankKey(peerKey, bankKeys);
  if (serverKey && peerKey && (peerIsBank || authenticated)) {
    const key = derive(serverKey, peerKey);
    if (key) candidates.push({ key, fromBank: peerIsBank, attempt: null });
  }

  try {
    return openWith(envelope, candidates);
  } catch (error) {
    const keyMissed = error instanceof NibPushCryptoError && error.reason === 'DECRYPT';
    if (!keyMissed || outerRef) throw error;
  }

  const recent = await prisma.directPendingPayment.findMany({
    where: { method: PUSH_METHOD, createdAt: { gte: new Date(Date.now() - CALLBACK_SCAN_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: CALLBACK_SCAN_LIMIT,
  });
  return openWith(envelope, recent.flatMap(keysOf));
}

/**
 * Field names, types and short prefixes of a rejected callback body, to work
 * out how the bank's format differs from the guide's envelope (§7.1). Encrypted
 * fields reveal nothing; plaintext values are cut to a few characters.
 */
export function describeCallbackShape(body: unknown): unknown {
  if (!body || typeof body !== 'object') return typeof body;
  if (Array.isArray(body)) return `array(${body.length})`;
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(body).slice(0, 20)) {
    if (typeof value === 'string') shape[key] = `string(${value.length}) "${value.slice(0, 8)}${value.length > 8 ? '…' : ''}"`;
    else if (Array.isArray(value)) shape[key] = `array(${value.length})`;
    else if (value && typeof value === 'object') shape[key] = `object{${Object.keys(value).slice(0, 10).join(',')}}`;
    else shape[key] = `${typeof value} ${String(value).slice(0, 8)}`;
  }
  return shape;
}

/**
 * Handles an encrypted callback body. `authenticated` = the request carried
 * our callback Basic credentials (§10.1); without them a callback is still
 * accepted when it opens with a key only the bank could hold, since that
 * proves who sent it — the bank may not have our credentials yet.
 * 200 for processed and duplicate callbacks, 401 when neither proof holds,
 * 404 for an unknown reference, 400 for a bad checksum or a payload that does not decrypt.
 */
export async function handlePushCallback(body: unknown, { authenticated }: { authenticated: boolean }): Promise<PushCallbackResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, message: 'Invalid callback payload.', transition: null };
  }
  const envelope = body as Record<string, unknown>;

  // The bank reports its own failures to build a callback as a plain
  // { "status": "FAILED", "message": "An internal server error occurred." }
  // with no payment result in it (seen on UAT). Nothing to apply, but the
  // message is the bank's to investigate, so it is logged in full.
  if (envelope.payload === undefined && typeof envelope.message === 'string') {
    console.error('[nib-push] bank sent an error instead of a payment result', {
      status: str(envelope.status),
      message: envelope.message.slice(0, 500),
      authenticated,
      shape: describeCallbackShape(envelope),
    });
    return { status: 400, message: 'Not a payment result.', transition: null };
  }

  let opened: Awaited<ReturnType<typeof openCallback>>;
  try {
    opened = await openCallback(envelope, authenticated);
  } catch (error) {
    if (error instanceof UnknownReferenceError) return { status: 404, message: 'Unknown transaction reference.', transition: null };
    if (error instanceof NibPushCryptoError) {
      // §7.3: a callback that fails verification is discarded and investigated.
      console.warn('[nib-push] SECURITY: callback rejected', {
        transactionRef: str(envelope.transactionRef),
        reason: error.reason,
        detail: error.message,
        authenticated,
        pubkey: str(envelope.pubkey),
        shape: describeCallbackShape(envelope),
      });
      if (!authenticated && error.reason === 'DECRYPT') return { status: 401, message: 'Unauthorized.', transition: null };
      const message = error.reason === 'CHECKSUM' ? 'Checksum mismatch.' : 'Payload could not be decrypted.';
      return { status: 400, message, transition: null };
    }
    throw error;
  }
  if (!authenticated && !opened.fromBank) {
    console.warn('[nib-push] SECURITY: callback without valid Basic auth, not encrypted with a known bank key', {
      pubkey: str(envelope.pubkey),
      shape: describeCallbackShape(envelope),
    });
    return { status: 401, message: 'Unauthorized.', transition: null };
  }
  if (!authenticated) {
    console.warn('[nib-push] callback without valid Basic auth accepted: only the bank holds its key. Give NIB the callback credentials (guide §10.1).');
  }

  const decrypted = opened.body;
  const innerRef = str(decrypted.transactionRef);
  let attempt = opened.attempt;
  if (!attempt) {
    attempt = innerRef ? await findPushAttempt(innerRef) : null;
    if (!attempt) return { status: 404, message: 'Unknown transaction reference.', transition: null };
  } else if (innerRef && innerRef !== attempt.transactionId) {
    return { status: 400, message: 'transactionRef does not match the encrypted payload.', transition: null };
  }

  const result = readCallbackResult(decrypted);

  await logCallback(attempt.transactionId, decrypted, 'RECEIVED');
  const transition = await applyPushOutcome(attempt.id, result, 'CALLBACK');
  await logCallback(attempt.transactionId, decrypted, 'PROCESSED');

  console.log('[nib-push] callback processed', {
    transactionRef: attempt.transactionId,
    outcome: result.outcome,
    changed: transition ? `${transition.from} -> ${transition.to}` : 'no change',
  });
  return { status: 200, message: 'Callback processed successfully', transition };
}
