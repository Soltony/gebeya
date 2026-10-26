/**
 * Envelope encryption for the NIB push-payment service (integration guide
 * §4 and §6). Every payload in both directions is AES-256-GCM encrypted with
 * a key agreed by ECDH on secp256k1:
 *
 *   key     = first 32 bytes of ECDH(one side's private key, other side's public key)
 *   payload = hex(AES-256-GCM(key, iv, JSON))
 *   salt    = hex(iv), 16 random bytes
 *   tag     = hex(GCM auth tag), 16 bytes
 *   cksum   = hex(SHA-256(ciphertext)), see ChecksumMode
 *   pubkey  = base64(sender's public key, uncompressed 65-byte point)
 *
 * Requests use a fresh one-time key pair. The bank's replies carry its public
 * key in `pubkey`, so they are decrypted with our matching private key.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, createPublicKey, ECDH, randomBytes, timingSafeEqual } from 'crypto';

const CURVE = 'secp256k1';
const IV_BYTES = 16;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;

/**
 * What the outbound checksum is computed over. The guide (§4.2) says the hex
 * text of the ciphertext; the requests in the bank's Postman collection,
 * including one it answered with 200, use the raw ciphertext bytes.
 */
export type ChecksumMode = 'bytes' | 'hex';

/** Encrypted body as it goes on the wire, minus the sender's public key. */
export type SealedPayload = { payload: string; salt: string; tag: string; cksum: string };
export type RequestEnvelope = SealedPayload & { pubkey: string };

export class NibPushCryptoError extends Error {
  constructor(readonly reason: 'BAD_KEY' | 'BAD_ENVELOPE' | 'CHECKSUM' | 'DECRYPT', message: string) {
    super(message);
  }
}

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** The ECDH secret is the AES-256 key; anything other than 32 bytes is hashed to 32. */
function toAesKey(secret: Buffer): Buffer {
  return secret.length === KEY_BYTES ? secret : sha256(secret);
}

/**
 * A base64 secp256k1 public key as an EC point. Accepts a raw point
 * (uncompressed, as the guide specifies, or compressed) and an SPKI DER key.
 */
function decodePublicKey(base64: string): Buffer {
  const bytes = Buffer.from(String(base64).trim(), 'base64');
  const isPoint =
    (bytes.length === 65 && bytes[0] === 0x04) || (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03));
  if (isPoint) return bytes;
  try {
    const jwk = createPublicKey({ key: bytes, format: 'der', type: 'spki' }).export({ format: 'jwk' });
    if (jwk.crv !== CURVE || !jwk.x || !jwk.y) throw new Error('not a secp256k1 key');
    return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  } catch {
    throw new NibPushCryptoError('BAD_KEY', 'Public key is not a base64 secp256k1 key.');
  }
}

function computeKey(ecdh: ReturnType<typeof createECDH>, peerPublicKeyBase64: string): Buffer {
  const peer = decodePublicKey(peerPublicKeyBase64);
  try {
    return toAesKey(ecdh.computeSecret(peer));
  } catch {
    throw new NibPushCryptoError('BAD_KEY', 'Public key is not a point on secp256k1.');
  }
}

function ecdhFromPrivateKey(privateKey: Buffer) {
  const ecdh = createECDH(CURVE);
  try {
    ecdh.setPrivateKey(privateKey);
  } catch {
    throw new NibPushCryptoError('BAD_KEY', 'Private key is not a secp256k1 key.');
  }
  return ecdh;
}

/** Key shared by the holder of `privateKey` and the owner of `peerPublicKeyBase64`. */
export function deriveSharedSecret(privateKey: Buffer, peerPublicKeyBase64: string): Buffer {
  return computeKey(ecdhFromPrivateKey(privateKey), peerPublicKeyBase64);
}

/** Whether two base64 public keys are the same key, whatever their encoding. */
export function samePublicKey(a: string, b: string): boolean {
  try {
    const uncompressed = (key: string) => ECDH.convertKey(decodePublicKey(key), CURVE, undefined, undefined, 'uncompressed') as Buffer;
    return uncompressed(a).equals(uncompressed(b));
  } catch {
    return false;
  }
}

/** Base64 uncompressed public key for a private key, the format the bank expects (§4.2, §10.2). */
export function publicKeyFromPrivate(privateKey: Buffer): string {
  return ecdhFromPrivateKey(privateKey).getPublicKey('base64', 'uncompressed');
}

/** Encrypts `value` under an agreed key. */
export function seal(key: Buffer, value: unknown, checksum: ChecksumMode = 'bytes'): SealedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const payload = ciphertext.toString('hex');
  return {
    payload,
    salt: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    cksum: sha256(checksum === 'hex' ? payload : ciphertext).toString('hex'),
  };
}

/**
 * Encrypts a request for the bank with a fresh one-time key pair (§4.3). The
 * returned private key and secret are what decrypt the bank's replies for
 * this request, so the caller keeps them with the transaction.
 */
export function encryptRequest(
  value: unknown,
  providerPublicKeyBase64: string,
  checksum: ChecksumMode = 'bytes',
): { envelope: RequestEnvelope; sharedSecret: Buffer; clientPrivateKey: Buffer } {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  const sharedSecret = computeKey(ecdh, providerPublicKeyBase64);
  return {
    envelope: { ...seal(sharedSecret, value, checksum), pubkey: ecdh.getPublicKey('base64', 'uncompressed') },
    sharedSecret,
    clientPrivateKey: ecdh.getPrivateKey(),
  };
}

function hexField(value: unknown, field: string): Buffer {
  // Buffer.from(…, 'hex') silently stops at the first bad character, so check first.
  if (typeof value !== 'string' || !HEX.test(value)) {
    throw new NibPushCryptoError('BAD_ENVELOPE', `${field} is missing or not hex.`);
  }
  return Buffer.from(value, 'hex');
}

/** Inbound checksums are accepted over either the ciphertext bytes or its hex text. */
export function checksumMatches(payloadHex: string, cksum: unknown): boolean {
  if (typeof cksum !== 'string' || !/^[0-9a-fA-F]{64}$/.test(cksum)) return false;
  const expected = Buffer.from(cksum, 'hex');
  return (
    timingSafeEqual(sha256(Buffer.from(payloadHex, 'hex')), expected) ||
    timingSafeEqual(sha256(payloadHex), expected)
  );
}

/**
 * Verifies and decrypts a callback or status reply, trying each candidate key
 * in turn. The checksum is checked before decrypting and the GCM tag while
 * decrypting, so only a key that really encrypted the message opens it.
 * Returns the body and the index of the key that worked.
 */
export function openEnvelope<T = Record<string, unknown>>(
  envelope: Partial<Record<keyof SealedPayload, unknown>>,
  keys: Buffer | Buffer[],
): { body: T; keyIndex: number } {
  const ciphertext = hexField(envelope.payload, 'payload');
  const iv = hexField(envelope.salt, 'salt');
  const tag = hexField(envelope.tag, 'tag');
  if (iv.length !== IV_BYTES && iv.length !== 12) throw new NibPushCryptoError('BAD_ENVELOPE', 'salt must be a 12- or 16-byte IV.');
  if (tag.length !== TAG_BYTES) throw new NibPushCryptoError('BAD_ENVELOPE', 'tag must be 16 bytes.');
  if (!checksumMatches(envelope.payload as string, envelope.cksum)) {
    throw new NibPushCryptoError('CHECKSUM', 'Checksum does not match the payload.');
  }

  const candidates = Array.isArray(keys) ? keys : [keys];
  for (let keyIndex = 0; keyIndex < candidates.length; keyIndex++) {
    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', candidates[keyIndex], iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      continue;
    }
    try {
      return { body: JSON.parse(plaintext) as T, keyIndex };
    } catch {
      throw new NibPushCryptoError('DECRYPT', 'Decrypted payload is not JSON.');
    }
  }
  throw new NibPushCryptoError('DECRYPT', 'Payload could not be decrypted.');
}
