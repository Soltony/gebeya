import { createHash, timingSafeEqual } from 'crypto';
import { getCallbackCredentials } from './config';

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * First 8 hex characters of a password's SHA-256: enough to tell whether two
 * sides hold the same password, useless for recovering it.
 */
export function passwordFingerprint(password: string): string {
  return sha256(password).toString('hex').slice(0, 8);
}

/**
 * What an Authorization header claims, for logging rejected callbacks: the
 * scheme, the username and the fingerprints of the password sent and of ours
 * (null when we have none configured). Never the password itself.
 */
export function describeAuthorization(authorization: string | null): {
  scheme: string | null;
  username: string | null;
  passwordFingerprint: string | null;
  configuredFingerprint: string | null;
} {
  const credentials = getCallbackCredentials();
  const configuredFingerprint = credentials ? passwordFingerprint(credentials.password) : null;
  const none = { scheme: null, username: null, passwordFingerprint: null, configuredFingerprint };

  const [scheme, value] = (authorization || '').trim().split(/\s+/, 2);
  if (!scheme) return none;
  if (scheme.toLowerCase() !== 'basic' || !value) return { ...none, scheme };
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return { ...none, scheme };
  return { scheme, username: decoded.slice(0, colon), passwordFingerprint: passwordFingerprint(decoded.slice(colon + 1)), configuredFingerprint };
}

/**
 * Checks `Authorization: Basic …` against NIB_PUSH_CALLBACK_USERNAME /
 * NIB_PUSH_CALLBACK_PASSWORD in constant time. Null when they are not configured.
 */
export function checkCallbackAuth(authorization: string | null): boolean | null {
  const credentials = getCallbackCredentials();
  if (!credentials) return null;
  const match = (authorization || '').match(/^Basic\s+(\S+)$/i);
  if (!match) return false;
  const given = Buffer.from(match[1], 'base64').toString('utf8');
  return timingSafeEqual(sha256(given), sha256(`${credentials.username}:${credentials.password}`));
}
