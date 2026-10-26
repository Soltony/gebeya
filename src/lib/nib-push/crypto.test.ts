import { createECDH, createHash, generateKeyPairSync } from 'crypto';
import { describe, expect, test } from 'vitest';
import {
  checksumMatches,
  deriveSharedSecret,
  encryptRequest,
  NibPushCryptoError,
  openEnvelope,
  publicKeyFromPrivate,
  seal,
} from './crypto';

/** The bank's side: a long-lived secp256k1 key pair. */
function bankKeys() {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey('base64') };
}

function reason(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof NibPushCryptoError) return error.reason;
    throw error;
  }
  return null;
}

const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe('encryptRequest', () => {
  test('the bank derives the same key from our pubkey and decrypts the payload', () => {
    const bank = bankKeys();
    const payload = { customerPhone: '251911000000', amount: 250, transactionRef: 'ref8k2j9x1qa' };

    const { envelope, sharedSecret, clientPrivateKey } = encryptRequest(payload, bank.publicKey);
    const bankKey = deriveSharedSecret(bank.privateKey, envelope.pubkey);

    expect(bankKey.equals(sharedSecret)).toBe(true);
    expect(deriveSharedSecret(clientPrivateKey, bank.publicKey).equals(sharedSecret)).toBe(true);
    expect(sharedSecret).toHaveLength(32);
    expect(openEnvelope(envelope, bankKey).body).toEqual(payload);
  });

  test('fields have the encodings of guide §4.2', () => {
    const { envelope } = encryptRequest({ a: 1 }, bankKeys().publicKey);
    const pubkey = Buffer.from(envelope.pubkey, 'base64');
    expect(envelope.pubkey).toHaveLength(88);
    expect(pubkey).toHaveLength(65);
    expect(pubkey[0]).toBe(0x04);
    expect(envelope.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope.cksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the checksum covers the ciphertext bytes by default, or its hex text', () => {
    const key = bankKeys().publicKey;
    const bytes = encryptRequest({ a: 1 }, key).envelope;
    const hex = encryptRequest({ a: 1 }, key, 'hex').envelope;
    expect(bytes.cksum).toBe(sha256Hex(Buffer.from(bytes.payload, 'hex')));
    expect(hex.cksum).toBe(sha256Hex(hex.payload));
  });

  test('accepts a bank key sent as SPKI DER', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const rawPrivate = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');

    const { envelope, sharedSecret } = encryptRequest({ a: 1 }, spki);
    expect(deriveSharedSecret(rawPrivate, envelope.pubkey).equals(sharedSecret)).toBe(true);
  });

  test('rejects a key that is not secp256k1', () => {
    expect(reason(() => encryptRequest({}, Buffer.from('not a key').toString('base64')))).toBe('BAD_KEY');
  });
});

describe('publicKeyFromPrivate', () => {
  test('gives the uncompressed base64 key the bank stores for callbacks', () => {
    const bank = bankKeys();
    expect(publicKeyFromPrivate(bank.privateKey)).toBe(bank.publicKey);
  });
});

describe('openEnvelope', () => {
  const key = Buffer.alloc(32, 7);
  const body = { transactionRef: 'ref8k2j9x1qa', statusCode: '0' };

  test('round-trips what seal produced, with either checksum', () => {
    expect(openEnvelope(seal(key, body), key).body).toEqual(body);
    expect(openEnvelope(seal(key, body, 'hex'), key).body).toEqual(body);
  });

  test('accepts the checksum of the requests in the bank Postman collection', () => {
    // Request the bank answered with 200 "Request accepted successfully".
    const payload =
      'dcea66b7dfed769fce8e7253846777339e9c7f022cfe0273e25aaf03ad2ea176860d3edb479edb500d62b5b6f29d63fe2f6ab5130f04f0817e9d9bed41661e67cf8f3b5bb9b97c4cf367c2d37531a9d8b27e4ed1b30e214f3b621ac055be498bd6c7c7d04eafde4ae40b1f38bbb7b4c8cc087adea0f2c93195137ba66b1cccd54e29dd96cf2c87ea36150cc76e1d3dfcf4e226ec4a31650d42134d79d8c7092d5ed5d375ecb916ef0ad3d07359cff983f14519156a3599b57f32f610dd6c553c285f7a8717cc3436605d27c95035';
    expect(checksumMatches(payload, 'a97098c16e628d0c9ba42598fd12fe8b124c6a22ece4224ec3d14f9edfabe3cd')).toBe(true);
  });

  test('tries each key and reports which one opened it', () => {
    const other = Buffer.alloc(32, 9);
    expect(openEnvelope(seal(key, body), [other, key])).toEqual({ body, keyIndex: 1 });
    expect(reason(() => openEnvelope(seal(key, body), [other]))).toBe('DECRYPT');
    expect(reason(() => openEnvelope(seal(key, body), []))).toBe('DECRYPT');
  });

  test('rejects a wrong checksum before decrypting', () => {
    expect(reason(() => openEnvelope({ ...seal(key, body), cksum: '0'.repeat(64) }, key))).toBe('CHECKSUM');
  });

  test('rejects tampered ciphertext even with a matching checksum', () => {
    const sealed = seal(key, body);
    const bytes = Buffer.from(sealed.payload, 'hex');
    bytes[0] ^= 1;
    const tampered = { ...sealed, payload: bytes.toString('hex'), cksum: sha256Hex(bytes) };
    expect(reason(() => openEnvelope(tampered, key))).toBe('DECRYPT');
  });

  test('rejects non-hex fields and truncated tags', () => {
    const sealed = seal(key, body);
    expect(reason(() => openEnvelope({ ...sealed, payload: `${sealed.payload}zz` }, key))).toBe('BAD_ENVELOPE');
    expect(reason(() => openEnvelope({ ...sealed, tag: sealed.tag.slice(0, 8) }, key))).toBe('BAD_ENVELOPE');
    expect(reason(() => openEnvelope({ ...sealed, salt: undefined }, key))).toBe('BAD_ENVELOPE');
  });
});
