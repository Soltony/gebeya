/**
 * NIB push-payment (USSD push) settings, read from the environment on each
 * call so a restart is the only thing needed after changing them. See the
 * "NIB USSD Push Payments" section of README.md for what each one does.
 */
import type { ChecksumMode } from './crypto';

export class NibPushConfigError extends Error {}

export type NibPushConfig = {
  baseUrl: string;
  username: string;
  password: string;
  /** Our company identifier code, which we register with the bank (§10.3): short, ALL CAPS, e.g. NIBBANK. */
  company: string;
  checksum: ChecksumMode;
};

const REQUIRED = ['NIB_PUSH_BASE_URL', 'NIB_PUSH_USERNAME', 'NIB_PUSH_PASSWORD', 'NIB_PUSH_COMPANY'] as const;

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

export function isNibPushEnabled(): boolean {
  return REQUIRED.every(name => env(name));
}

export function getNibPushConfig(): NibPushConfig {
  const missing = REQUIRED.filter(name => !env(name));
  if (missing.length > 0) throw new NibPushConfigError(`${missing.join(', ')} not configured.`);

  const checksum = (env('NIB_PUSH_CHECKSUM') || 'bytes').toLowerCase();
  if (checksum !== 'bytes' && checksum !== 'hex') {
    throw new NibPushConfigError(`NIB_PUSH_CHECKSUM must be "bytes" or "hex", got "${checksum}".`);
  }

  return {
    baseUrl: env('NIB_PUSH_BASE_URL')!.replace(/\/+$/, ''),
    username: env('NIB_PUSH_USERNAME')!,
    password: env('NIB_PUSH_PASSWORD')!,
    company: env('NIB_PUSH_COMPANY')!,
    checksum,
  };
}

/** The bank's public key (base64), used only when get-pub-key does not answer. */
export function getBankPublicKeyFallback(): string | null {
  return env('NIB_PUSH_BANK_PUBLIC_KEY');
}

/** Basic-auth credentials the bank uses on callbacks and on our public-key URL (§10.1, §10.2). */
export function getCallbackCredentials(): { username: string; password: string } | null {
  const username = env('NIB_PUSH_CALLBACK_USERNAME');
  const password = env('NIB_PUSH_CALLBACK_PASSWORD');
  return username && password ? { username, password } : null;
}

/**
 * Our long-term secp256k1 private key (64 hex characters or base64). The bank
 * holds its public half (§10.2) and encrypts callbacks to it.
 */
export function getServerPrivateKey(): Buffer | null {
  const value = env('NIB_PUSH_SERVER_PRIVATE_KEY');
  if (!value) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new NibPushConfigError('NIB_PUSH_SERVER_PRIVATE_KEY must be a 32-byte secp256k1 key in hex or base64.');
  return key;
}
