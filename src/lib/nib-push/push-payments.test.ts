import { createECDH } from 'crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { PushResult } from './outcome';

// An in-memory stand-in for the few Prisma calls settlement makes, with
// transactions that roll back on error.
const { db, fakePrisma } = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db = { attempts: [] as Row[], fts: [] as Row[], orders: [] as Row[] };

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('in' in cond) return cond.in.includes(row[key]);
        if ('not' in cond) return row[key] !== cond.not;
        if ('gte' in cond) return row[key] >= cond.gte;
      }
      return row[key] === cond;
    });

  const updateMany = (rows: Row[]) => async ({ where, data }: Row) => {
    let count = 0;
    for (const row of rows.filter(r => matches(r, where))) {
      for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
      count++;
    }
    return { count };
  };

  // Prisma returns snapshots, not live rows.
  const copy = (row: Row | undefined) => (row ? { ...row } : null);

  const fakePrisma: Row = {
    directPendingPayment: {
      findUnique: async ({ where }: Row) => copy(db.attempts.find(a => matches(a, where))),
      findMany: async ({ where }: Row) => db.attempts.filter(a => matches(a, where)).map(a => ({ ...a })),
      create: async ({ data }: Row) => {
        db.attempts.push({ createdAt: new Date(), ...data, id: `id-${data.transactionId}` });
      },
      update: async ({ where, data }: Row) => {
        Object.assign(db.attempts.find(a => matches(a, where))!, data);
      },
      updateMany: updateMany(db.attempts),
      count: async ({ where }: Row) => db.attempts.filter(a => matches(a, where)).length,
    },
    directPaymentFt: {
      findUnique: async ({ where }: Row) => copy(db.fts.find(f => matches(f, where))),
      create: async ({ data }: Row) => {
        if (db.fts.some(f => f.cbsReference === data.cbsReference || f.directPendingPaymentId === data.directPendingPaymentId)) {
          const { Prisma } = await import('@prisma/client');
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        }
        db.fts.push({ ...data });
      },
    },
    order: {
      updateMany: updateMany(db.orders),
      findUnique: async ({ where }: Row) => copy(db.orders.find(o => matches(o, where))),
    },
    paymentTransaction: { upsert: async () => {} },
    $transaction: async (run: (tx: Row) => Promise<unknown>) => {
      const snapshot = JSON.parse(JSON.stringify({ attempts: db.attempts, fts: db.fts, orders: db.orders }));
      try {
        return await run(fakePrisma);
      } catch (error) {
        db.attempts.splice(0, db.attempts.length, ...snapshot.attempts);
        db.fts.splice(0, db.fts.length, ...snapshot.fts);
        db.orders.splice(0, db.orders.length, ...snapshot.orders);
        throw error;
      }
    },
  };
  return { db, fakePrisma };
});

vi.mock('@/lib/prisma', () => ({ default: fakePrisma }));
vi.mock('@/lib/audit-log', () => ({
  createAuditLog: vi.fn(async () => {}),
  auditExternalApiRequest: vi.fn(async () => ''),
  auditExternalApiResponse: vi.fn(async () => ''),
  auditExternalApiError: vi.fn(async () => ''),
  newAuditCorrelationId: () => 'test',
}));

const { applyPushOutcome, effectiveStatus, FtConflictError, handlePushCallback, isNoRecordReply, resolvePushPaymentManually, startPushPayment } =
  await import('./push-payments');
const { createAuditLog } = await import('@/lib/audit-log');
const { deriveSharedSecret, openEnvelope, publicKeyFromPrivate, seal } = await import('./crypto');
const { NibPushNetworkError } = await import('./client');
const { describeCallbackShape } = await import('./push-payments');
const { describeAuthorization, passwordFingerprint } = await import('./callback-auth');

function result(outcome: PushResult['outcome'], extra: Partial<PushResult> = {}): PushResult {
  return { outcome, transactionRef: null, statusDesc: null, cbsReference: null, payerAccount: null, amount: null, ...extra };
}

function addAttempt(id: string, status = 'AWAITING_PIN', orderId = 'order1') {
  db.attempts.push({ id, transactionId: `ref${id}`, orderId, borrowerId: '251911223344', merchantId: 'm1', amount: 250, status, method: 'USSD_PUSH' });
}

const attempt = (id: string) => db.attempts.find(a => a.id === id)!;
const order = () => db.orders[0];
const auditActions = () => vi.mocked(createAuditLog).mock.calls.map(([entry]) => entry.action);

beforeEach(() => {
  db.attempts.length = 0;
  db.fts.length = 0;
  db.orders.length = 0;
  db.orders.push({ id: 'order1', status: 'ON_DELIVERY' });
  vi.mocked(createAuditLog).mockClear();
});

describe('applyPushOutcome', () => {
  test('success settles the attempt, records the FT and delivers the order', async () => {
    addAttempt('a1');
    const transition = await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1', amount: 250, payerAccount: '1000123456789' }), 'CALLBACK');

    expect(transition).toMatchObject({ from: 'AWAITING_PIN', to: 'COMPLETED', orderDelivered: true, needsRefund: null, cbsReference: 'FT1' });
    expect(attempt('a1')).toMatchObject({ status: 'COMPLETED', payerAccount: '1000123456789' });
    expect(attempt('a1').completedAt).toBeInstanceOf(Date);
    expect(db.fts).toEqual([{ cbsReference: 'FT1', directPendingPaymentId: 'a1' }]);
    expect(order().status).toBe('DELIVERED');
    expect(auditActions()).toEqual(['DIRECT_PAYMENT_SUCCESS']);
  });

  test('a duplicate callback changes nothing', async () => {
    addAttempt('a1');
    await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');
    vi.mocked(createAuditLog).mockClear();

    expect(await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK')).toBeNull();
    expect(await applyPushOutcome('a1', result('FAILED'), 'STATUS')).toBeNull();
    expect(attempt('a1').status).toBe('COMPLETED');
    expect(auditActions()).toEqual([]);
  });

  test('a decline fails the attempt and leaves the order on delivery', async () => {
    addAttempt('a1');
    const transition = await applyPushOutcome('a1', result('FAILED', { statusDesc: 'Wrong PIN' }), 'CALLBACK');

    expect(transition).toMatchObject({ to: 'FAILED', statusDesc: 'Wrong PIN', orderDelivered: false });
    expect(order().status).toBe('ON_DELIVERY');
    expect(db.fts).toEqual([]);
  });

  test('"server busy" with an FT is held for review and reserves the FT', async () => {
    addAttempt('a1');
    const transition = await applyPushOutcome('a1', result('PROCESSING', { statusDesc: 'server busy', cbsReference: 'FT1' }), 'CALLBACK');

    expect(transition?.to).toBe('PROCESSING');
    expect(order().status).toBe('ON_DELIVERY');
    expect(db.fts).toEqual([{ cbsReference: 'FT1', directPendingPaymentId: 'a1' }]);
    expect(auditActions()).toEqual(['DIRECT_PAYMENT_NEEDS_REVIEW']);

    // The status endpoint later confirms it with the same FT.
    expect((await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'STATUS'))?.to).toBe('COMPLETED');
    expect(order().status).toBe('DELIVERED');
  });

  test('an FT already used by another payment rolls back and holds the attempt for review', async () => {
    addAttempt('a1');
    addAttempt('a2', 'AWAITING_PIN', 'order2');
    db.orders.push({ id: 'order2', status: 'ON_DELIVERY' });
    await applyPushOutcome('a2', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');

    const transition = await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');

    expect(transition).toMatchObject({ to: 'PROCESSING', orderDelivered: false });
    expect(attempt('a1').status).toBe('PROCESSING');
    expect(attempt('a1').statusDesc).toMatch(/already recorded on another payment/);
    expect(order().status).toBe('ON_DELIVERY');
    expect(db.fts).toEqual([{ cbsReference: 'FT1', directPendingPaymentId: 'a2' }]);
  });

  test('a second successful payment for the same order is flagged for a refund', async () => {
    addAttempt('a1');
    addAttempt('a2');
    await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');
    vi.mocked(createAuditLog).mockClear();

    const transition = await applyPushOutcome('a2', result('SUCCESS', { cbsReference: 'FT2' }), 'CALLBACK');

    expect(transition).toMatchObject({ to: 'COMPLETED', orderDelivered: false, needsRefund: 'DUPLICATE_PAYMENT' });
    expect(auditActions()).toEqual(['DIRECT_PAYMENT_SUCCESS', 'DIRECT_PAYMENT_NEEDS_REFUND']);
  });

  test('payment for an order cancelled meanwhile is recorded and flagged for a refund', async () => {
    addAttempt('a1');
    order().status = 'CANCELLED';

    const transition = await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');

    expect(transition).toMatchObject({ to: 'COMPLETED', orderDelivered: false, needsRefund: 'ORDER_CANCELLED' });
    expect(order().status).toBe('CANCELLED');
  });

  test('success for the wrong amount does not deliver the order', async () => {
    addAttempt('a1');
    const transition = await applyPushOutcome('a1', result('SUCCESS', { amount: 25, cbsReference: 'FT1' }), 'CALLBACK');

    expect(transition?.to).toBe('PROCESSING');
    expect(order().status).toBe('ON_DELIVERY');
  });
});

describe('handlePushCallback', () => {
  const keyPair = () => {
    const ecdh = createECDH('secp256k1');
    ecdh.generateKeys();
    return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey('base64') };
  };
  const bank = keyPair();
  const server = keyPair(); // our long-term key; the bank holds its public half (§10.2)

  /** An attempt as startPushPayment stores it, with its one-time key. */
  function addKeyedAttempt(id: string) {
    const client = keyPair();
    addAttempt(id);
    Object.assign(attempt(id), {
      createdAt: new Date(),
      clientPrivateKey: client.privateKey.toString('base64'),
      sharedSecret: deriveSharedSecret(client.privateKey, bank.publicKey).toString('base64'),
    });
    return client;
  }

  const success = (transactionRef: string) => ({
    transactionRef,
    statusDesc: 'Payment successful',
    statusCode: '0',
    cbsreference: 'FT26145XYZ88',
    company: 'GEBEYA',
    amount: '250',
  });

  /** The bank encrypts between its key and `recipientPublicKey`, and sends only the envelope (§7.1). */
  const callback = (recipientPublicKey: string, body: unknown) => ({
    ...seal(deriveSharedSecret(bank.privateKey, recipientPublicKey), body),
    pubkey: bank.publicKey,
  });

  const withAuth = { authenticated: true };
  const withoutAuth = { authenticated: false };

  beforeEach(() => {
    process.env.NIB_PUSH_SERVER_PRIVATE_KEY = server.privateKey.toString('hex');
    process.env.NIB_PUSH_BANK_PUBLIC_KEY = bank.publicKey;
  });

  test('opens a guide-style callback with our server key and settles the attempt', async () => {
    addKeyedAttempt('a1');
    expect(publicKeyFromPrivate(server.privateKey)).toBe(server.publicKey);

    const response = await handlePushCallback(callback(server.publicKey, success('refa1')), withAuth);

    expect(response).toMatchObject({ status: 200, message: 'Callback processed successfully' });
    expect(response.transition).toMatchObject({ to: 'COMPLETED', cbsReference: 'FT26145XYZ88' });
    expect(order().status).toBe('DELIVERED');
  });

  test("falls back to matching an attempt's one-time key when the server key does not open it", async () => {
    addKeyedAttempt('a1');
    const client = addKeyedAttempt('a2');
    delete process.env.NIB_PUSH_SERVER_PRIVATE_KEY;

    const response = await handlePushCallback(callback(client.publicKey, success('refa2')), withAuth);

    expect(response.status).toBe(200);
    expect(attempt('a2').status).toBe('COMPLETED');
    expect(attempt('a1').status).toBe('AWAITING_PIN');
  });

  test('a callback opened with one attempt key but naming another reference is rejected', async () => {
    const client = addKeyedAttempt('a1');
    addKeyedAttempt('a2');
    delete process.env.NIB_PUSH_SERVER_PRIVATE_KEY;

    const response = await handlePushCallback(callback(client.publicKey, success('refa2')), withAuth);

    expect(response.status).toBe(400);
    expect(attempt('a1').status).toBe('AWAITING_PIN');
    expect(attempt('a2').status).toBe('AWAITING_PIN');
  });

  test('an unknown reference is 404', async () => {
    addKeyedAttempt('a1');
    expect((await handlePushCallback(callback(server.publicKey, success('refnope')), withAuth)).status).toBe(404);
  });

  test('a bad checksum or a foreign key is 400 and changes nothing', async () => {
    addKeyedAttempt('a1');
    const good = callback(server.publicKey, success('refa1'));

    expect(await handlePushCallback({ ...good, cksum: '0'.repeat(64) }, withAuth)).toMatchObject({ status: 400, message: 'Checksum mismatch.' });
    expect((await handlePushCallback(callback(keyPair().publicKey, success('refa1')), withAuth)).status).toBe(400);
    expect(attempt('a1').status).toBe('AWAITING_PIN');
  });

  describe('without our Basic credentials (the bank may not have them yet)', () => {
    test("is accepted when encrypted with the bank's own key", async () => {
      addKeyedAttempt('a1');
      const response = await handlePushCallback(callback(server.publicKey, success('refa1')), withoutAuth);
      expect(response.status).toBe(200);
      expect(attempt('a1').status).toBe('COMPLETED');
    });

    test("is accepted when it opens with the attempt's agreed secret", async () => {
      const client = addKeyedAttempt('a1');
      delete process.env.NIB_PUSH_SERVER_PRIVATE_KEY;
      const response = await handlePushCallback(callback(client.publicKey, success('refa1')), withoutAuth);
      expect(response.status).toBe(200);
      expect(attempt('a1').status).toBe('COMPLETED');
    });

    test('is refused when anyone else encrypted it to our public key', async () => {
      addKeyedAttempt('a1');
      const forger = keyPair();
      // Our public key is public: a forger can agree a key with it using their own key pair.
      const forged = { ...seal(deriveSharedSecret(forger.privateKey, server.publicKey), success('refa1')), pubkey: forger.publicKey };

      expect((await handlePushCallback(forged, withoutAuth)).status).toBe(401);
      expect(attempt('a1').status).toBe('AWAITING_PIN');
      // The same message with valid credentials is the bank's word (Basic auth).
      expect((await handlePushCallback(forged, withAuth)).status).toBe(200);
    });
  });
});

describe('startPushPayment', () => {
  const bankEcdh = createECDH('secp256k1');
  bankEcdh.generateKeys();

  /** A bank that serves its key and records each transfer, decrypted. */
  function stubBank(transferReply: { status: number; body: unknown }) {
    const transfers: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (url.endsWith('/nib-push-payment/api/get-pub-key')) return json(200, { publicKey: bankEcdh.getPublicKey('base64') });
      const envelope = JSON.parse(String(init?.body));
      transfers.push(openEnvelope(envelope, deriveSharedSecret(bankEcdh.getPrivateKey(), envelope.pubkey)).body);
      return json(transferReply.status, transferReply.body);
    });
    return transfers;
  }

  const input = {
    orderId: 'order1',
    borrowerId: '251911223344',
    merchantId: 'm1',
    amount: 1000,
    customerPhone: '251911223344',
    creditAccount: '7000101737506',
    merchantName: 'Tony Solomon',
    description: 'Order #UMU9VF',
  };

  beforeEach(() => {
    Object.assign(process.env, {
      NIB_PUSH_BASE_URL: 'http://bank.test',
      NIB_PUSH_USERNAME: 'nib',
      NIB_PUSH_PASSWORD: 'secret',
      NIB_PUSH_COMPANY: 'GEBYA',
    });
  });

  test('the inner payload holds only the §5.3.1 fields; the bank rejects anything else', async () => {
    const transfers = stubBank({ status: 200, body: { message: 'Request accepted successfully', statusCode: 200 } });

    const result = await startPushPayment(input);

    expect(result.status).toBe('AWAITING_PIN');
    // UAT answered an extra resultUrl with "object instance has properties which are not allowed by the schema".
    expect(Object.keys(transfers[0]).sort()).toEqual(
      ['amount', 'company', 'creditAccount', 'customerPhone', 'description', 'merchantName', 'transactionRef'].sort(),
    );
    expect(transfers[0]).toMatchObject({
      customerPhone: '251911223344',
      amount: 1000,
      merchantName: 'Tony Solomon',
      description: 'Order #UMU9VF',
      company: 'GEBYA',
      creditAccount: '7000101737506',
    });
    const stored = db.attempts.find(a => a.transactionId === result.transactionRef)!;
    expect(stored).toMatchObject({ status: 'AWAITING_PIN', method: 'USSD_PUSH' });
    expect(stored.sharedSecret && stored.clientPrivateKey).toBeTruthy();
  });

  test('an HTTP 200 carrying "Invalid Credentials" is a rejection, not a sent prompt', async () => {
    stubBank({ status: 200, body: { message: 'Unable to accept request', statusCode: 401, details: 'Invalid Credentials' } });

    const result = await startPushPayment(input);

    expect(result).toMatchObject({ status: 'FAILED', message: 'Invalid Credentials' });
  });

  // Last in this file: it leaves the push service marked as down.
  test('after a transfer gets no answer, the next payment is refused at once and nothing is recorded', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/nib-push-payment/api/get-pub-key')) {
        return new Response(JSON.stringify({ publicKey: bankEcdh.getPublicKey('base64') }), { status: 200 });
      }
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const first = await startPushPayment(input);
    expect(first.status).toBe('PENDING');
    const recorded = db.attempts.length;

    await expect(startPushPayment(input)).rejects.toBeInstanceOf(NibPushNetworkError);
    expect(db.attempts.length).toBe(recorded);
  });
});

describe('resolvePushPaymentManually', () => {
  test('an FT from the bank statement settles even a failed attempt and delivers the order', async () => {
    addAttempt('a1', 'FAILED');
    const transition = await resolvePushPaymentManually('a1', 'FT252748HG7N', 'checker1');

    expect(transition).toMatchObject({ from: 'FAILED', to: 'COMPLETED', cbsReference: 'FT252748HG7N', orderDelivered: true });
    expect(db.fts).toEqual([{ cbsReference: 'FT252748HG7N', directPendingPaymentId: 'a1' }]);
    expect(order().status).toBe('DELIVERED');
    expect(vi.mocked(createAuditLog).mock.calls[0][0]).toMatchObject({
      action: 'DIRECT_PAYMENT_SUCCESS',
      details: expect.objectContaining({ source: 'MANUAL', resolvedBy: 'checker1' }),
    });
  });

  test('an attempt the bank already confirmed is left as it is', async () => {
    addAttempt('a1');
    await applyPushOutcome('a1', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');
    expect(await resolvePushPaymentManually('a1', 'FT1', 'checker1')).toBeNull();
  });

  test('an FT that already settled another payment is refused, and nothing changes', async () => {
    addAttempt('a1');
    addAttempt('a2', 'AWAITING_PIN', 'order2');
    db.orders.push({ id: 'order2', status: 'ON_DELIVERY' });
    await applyPushOutcome('a2', result('SUCCESS', { cbsReference: 'FT1' }), 'CALLBACK');

    await expect(resolvePushPaymentManually('a1', 'FT1', 'checker1')).rejects.toBeInstanceOf(FtConflictError);
    expect(attempt('a1').status).toBe('AWAITING_PIN');
    expect(order().status).toBe('ON_DELIVERY');
  });
});

describe('logging rejected callbacks', () => {
  test('describes the body without revealing more than a short prefix of each value', () => {
    expect(
      describeCallbackShape({ data: { payload: 'ab' }, statusCode: '0', cbsreference: 'FT252748HG7N', amount: 1000, items: [1, 2] }),
    ).toEqual({
      data: 'object{payload}',
      statusCode: 'string(1) "0"',
      cbsreference: 'string(12) "FT252748…"',
      amount: 'number 1000',
      items: 'array(2)',
    });
    expect(describeCallbackShape(null)).toBe('object');
    expect(describeCallbackShape('text')).toBe('string');
  });

  test('describes the Authorization header with password fingerprints, never the password', () => {
    process.env.NIB_PUSH_CALLBACK_USERNAME = 'nibpush';
    process.env.NIB_PUSH_CALLBACK_PASSWORD = 'something-else';
    const header = 'Basic ' + Buffer.from('nibpush:s3cret-value').toString('base64');

    const described = describeAuthorization(header);
    expect(described).toEqual({
      scheme: 'Basic',
      username: 'nibpush',
      passwordFingerprint: passwordFingerprint('s3cret-value'),
      configuredFingerprint: passwordFingerprint('something-else'),
    });
    expect(described.passwordFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(described)).not.toContain('s3cret');
    expect(describeAuthorization('Bearer abc')).toMatchObject({ scheme: 'Bearer', username: null, passwordFingerprint: null });
    expect(describeAuthorization(null)).toMatchObject({ scheme: null, username: null });
  });

  test("the bank's plain error report is logged and refused, not treated as a forgery", async () => {
    const response = await handlePushCallback({ status: 'FAILED', message: 'An internal server error occurred.' }, { authenticated: false });
    expect(response).toMatchObject({ status: 400, message: 'Not a payment result.' });
  });
});

describe('reading bank replies (as the UAT service sends them)', () => {
  test('an HTTP 200 that carries an error code in the body is that error', () => {
    // UAT, wrong or missing credentials.
    expect(effectiveStatus({ status: 200, body: { message: 'Unable to accept request', statusCode: 401, details: 'Invalid Credentials' } })).toBe(401);
    // §5.3.3 success.
    expect(effectiveStatus({ status: 200, body: { message: 'Request accepted successfully', statusCode: 200 } })).toBe(200);
    // An encrypted envelope has no statusCode.
    expect(effectiveStatus({ status: 200, body: { payload: 'ab', salt: 'cd' } })).toBe(200);
    // A real HTTP error wins over the body.
    expect(effectiveStatus({ status: 400, body: { statusCode: 200 } })).toBe(400);
  });

  test('only a 404 means "no record"; the UAT 401 reply says nothing', () => {
    // What UAT returned for refi98b4jjl5, a transfer the customer had paid (FT252748HG7N).
    const uat = {
      transactionRef: 'refi98b4jjl5',
      customerPhone: '',
      amount: '',
      paymentStatus: '',
      cbsReference: '',
      message: '',
      company: '',
      updatedAt: '',
    };
    expect(isNoRecordReply({ status: 401, body: uat })).toBe(false);
    expect(isNoRecordReply({ status: 404, body: null })).toBe(true);
  });
});

test('Prisma error class used for FT clashes is the one the fake throws', () => {
  expect(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }).code).toBe('P2002');
});
