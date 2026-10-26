/**
 * HTTP client for the NIB push-payment service: get-pub-key, transfer and
 * status, all with HTTP Basic auth. Bodies are returned as received; the
 * caller decrypts them (see ./crypto).
 */
import { getBankPublicKeyFallback, getNibPushConfig } from './config';
import type { RequestEnvelope } from './crypto';

export const NIB_PUSH_PATHS = {
  publicKey: '/nib-push-payment/api/get-pub-key',
  transfer: '/push-payment/transfer',
  status: (transactionRef: string) => `/push-payment/status/${encodeURIComponent(transactionRef)}`,
};

const PUBLIC_KEY_TTL_MS = 12 * 60 * 60 * 1000;
// The key endpoint answers in well under a second or hangs, so the customer
// is not kept waiting on it.
const PUBLIC_KEY_TIMEOUT_MS = 8_000;
const TRANSFER_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 10_000;
// One try plus one retry.
const MAX_ATTEMPTS = 2;
// UAT's gateway has gone through spells of accepting connections and never
// answering. Once a service gets no answer, optional calls to it (status
// checks, key fetches with a fallback) are skipped for a while instead of
// each waiting out its timeout.
const OUTAGE_COOLDOWN_MS = 30_000;

/** No HTTP response at all: network error or timeout. */
export class NibPushNetworkError extends Error {}

/** The call was not made: the service did not answer a recent call. */
export class NibPushUnavailableError extends NibPushNetworkError {}

/** The key service (get-pub-key) and the push service (transfer, status) are separate backends. */
export type NibPushService = 'key' | 'push';

const outageUntil: Record<NibPushService, number> = { key: 0, push: 0 };

function serviceOf(path: string): NibPushService {
  return path === NIB_PUSH_PATHS.publicKey ? 'key' : 'push';
}

/** True while a recent call to `service` got no answer. */
export function isNibPushServiceDown(service: NibPushService): boolean {
  return Date.now() < outageUntil[service];
}

/** The provider answered with a status the caller cannot use. */
export class NibPushHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type NibPushResponse = { status: number; body: unknown; durationMs: number };

let cachedPublicKey: { value: string; expiresAt: number } | null = null;

/** Drops the cached provider key, e.g. after a 401 (the provider may have rotated it). */
export function forgetProviderPublicKey() {
  cachedPublicKey = null;
}

/**
 * Bank public keys we can vouch for without a network call: the one last
 * fetched from get-pub-key (even past its cache lifetime) and NIB_PUSH_BANK_PUBLIC_KEY.
 */
export function knownBankPublicKeys(): string[] {
  return [cachedPublicKey?.value, getBankPublicKeyFallback()].filter((key): key is string => Boolean(key));
}

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function call(method: 'GET' | 'POST', path: string, options: { body?: unknown; timeoutMs: number }): Promise<NibPushResponse> {
  const config = getNibPushConfig();
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: basicAuth(config.username, config.password),
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    outageUntil[serviceOf(path)] = Date.now() + OUTAGE_COOLDOWN_MS;
    throw new NibPushNetworkError(`${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  outageUntil[serviceOf(path)] = 0;

  const text = await res.text().catch(() => '');
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep the text body.
  }
  return { status: res.status, body, durationMs: Date.now() - startedAt };
}

async function withRetry(
  run: () => Promise<NibPushResponse>,
  shouldRetry: (result: NibPushResponse) => boolean,
  { retryNetworkErrors = true } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await run();
      if (attempt < MAX_ATTEMPTS && shouldRetry(result)) continue;
      return result;
    } catch (error) {
      if (!(error instanceof NibPushNetworkError) || !retryNetworkErrors || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}

async function fetchProviderPublicKey(): Promise<string> {
  const res = await withRetry(() => call('GET', NIB_PUSH_PATHS.publicKey, { timeoutMs: PUBLIC_KEY_TIMEOUT_MS }), r => r.status >= 500, {
    retryNetworkErrors: false,
  });
  // { publicKey } per the guide (§5.2) and the UAT service; nibServerPublicKey per an earlier draft.
  const body = res.body as { publicKey?: unknown; nibServerPublicKey?: unknown } | null;
  const key = body?.publicKey ?? body?.nibServerPublicKey;
  if (res.status !== 200 || typeof key !== 'string' || !key.trim()) {
    throw new NibPushHttpError(res.status, `get-pub-key returned HTTP ${res.status} without a public key.`);
  }
  return key.trim();
}

/**
 * The provider's public key, cached in memory for 12 hours. When get-pub-key
 * fails and NIB_PUSH_BANK_PUBLIC_KEY is set, that key is used instead (not
 * cached, so the next request asks the bank again). `fromCache` is true
 * whenever the key may be stale.
 */
export async function getProviderPublicKey(): Promise<{ key: string; fromCache: boolean }> {
  if (cachedPublicKey && cachedPublicKey.expiresAt > Date.now()) return { key: cachedPublicKey.value, fromCache: true };

  const fallback = getBankPublicKeyFallback();
  if (fallback && isNibPushServiceDown('key')) return { key: fallback, fromCache: true };

  try {
    const key = await fetchProviderPublicKey();
    cachedPublicKey = { value: key, expiresAt: Date.now() + PUBLIC_KEY_TTL_MS };
    return { key, fromCache: false };
  } catch (error) {
    if (!fallback || !(error instanceof NibPushNetworkError || error instanceof NibPushHttpError)) throw error;
    console.warn('[nib-push] get-pub-key failed; using NIB_PUSH_BANK_PUBLIC_KEY', { error: error.message });
    return { key: fallback, fromCache: true };
  }
}

/**
 * Sends the encrypted transfer (PIN prompt) request. Never retried here: the
 * guide (§8.2) requires checking the status endpoint before any retry, which
 * the customer's resend does.
 */
export function postTransfer(envelope: RequestEnvelope): Promise<NibPushResponse> {
  return call('POST', NIB_PUSH_PATHS.transfer, { body: envelope, timeoutMs: TRANSFER_TIMEOUT_MS });
}

/**
 * Encrypted status of a transfer. Read-only, so a 5xx is retried; skipped
 * (NibPushUnavailableError) while the push service is not answering.
 */
export async function getTransferStatus(transactionRef: string): Promise<NibPushResponse> {
  if (isNibPushServiceDown('push')) throw new NibPushUnavailableError('The push service did not answer a recent call.');
  return withRetry(() => call('GET', NIB_PUSH_PATHS.status(transactionRef), { timeoutMs: STATUS_TIMEOUT_MS }), r => r.status >= 500, {
    retryNetworkErrors: false,
  });
}
