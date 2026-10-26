/**
 * Local stand-in for the NIB push-payment service (Push Payment Integration
 * Guide v1.0), for trying Telegram USSD push payments end to end without the
 * bank. It serves get-pub-key, transfer and status with the same encryption,
 * and posts the encrypted callback a few seconds after each transfer, as if
 * the customer had answered the PIN prompt.
 *
 *   node scripts/mock-nib-push.cjs
 *
 * Then run the app with:
 *   NIB_PUSH_BASE_URL=http://localhost:4010
 *   NIB_PUSH_USERNAME=mock  NIB_PUSH_PASSWORD=mock  NIB_PUSH_COMPANY=GEBEYA
 *   NIB_PUSH_CALLBACK_USERNAME=nib  NIB_PUSH_CALLBACK_PASSWORD=mock-callback
 *   NIB_PUSH_SERVER_PRIVATE_KEY=<our key>  and  MOCK_PARTNER_PUBLIC_KEY=<its public key>
 *
 * MOCK_OUTCOME chooses what the "customer" does:
 *   success      approves (default)
 *   decline      wrong PIN (statusCode "1")
 *   busy         statusCode "1" "server busy" with an FT: money moved, held for review
 *   silent-paid  no callback; the status endpoint reports PAID
 *   silent       no callback; the status endpoint stays PENDING
 * A customerPhone ending in 0000 gets 400 "User not found".
 *
 * Other settings: MOCK_PORT (4010), MOCK_USERNAME / MOCK_PASSWORD (mock),
 * MOCK_CALLBACK_URL (http://localhost:9002/api/nib-push/callback; a resultUrl
 * in the request wins), MOCK_CALLBACK_USERNAME / MOCK_CALLBACK_PASSWORD
 * (nib / mock-callback), MOCK_CALLBACK_DELAY_MS (5000), MOCK_CHECKSUM
 * (bytes | hex, for what the mock sends). Without MOCK_PARTNER_PUBLIC_KEY,
 * callbacks are encrypted to the transfer's one-time key instead.
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.MOCK_PORT) || 4010;
const USERNAME = process.env.MOCK_USERNAME || 'mock';
const PASSWORD = process.env.MOCK_PASSWORD || 'mock';
const OUTCOME = process.env.MOCK_OUTCOME || 'success';
const CALLBACK_URL = process.env.MOCK_CALLBACK_URL || 'http://localhost:9002/api/nib-push/callback';
const CALLBACK_USERNAME = process.env.MOCK_CALLBACK_USERNAME || 'nib';
const CALLBACK_PASSWORD = process.env.MOCK_CALLBACK_PASSWORD || 'mock-callback';
const CALLBACK_DELAY_MS = Number(process.env.MOCK_CALLBACK_DELAY_MS) || 5000;
const PARTNER_PUBLIC_KEY = process.env.MOCK_PARTNER_PUBLIC_KEY || null;
const CHECKSUM = process.env.MOCK_CHECKSUM === 'hex' ? 'hex' : 'bytes';

const bankKey = crypto.createECDH('secp256k1');
bankKey.generateKeys();
const bankPublicKey = bankKey.getPublicKey('base64');

/** transactionRef -> { clientPublicKey, request, answeredAt, result } */
const transfers = new Map();

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

/** Envelope to `recipientPublicKey`, as the bank sends status replies and callbacks. */
function seal(recipientPublicKey, value) {
  const key = bankKey.computeSecret(Buffer.from(recipientPublicKey, 'base64'));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const payload = ciphertext.toString('hex');
  return {
    payload,
    pubkey: bankPublicKey,
    cksum: sha256(CHECKSUM === 'hex' ? payload : ciphertext),
    salt: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

function open(envelope) {
  const ciphertext = Buffer.from(envelope.payload, 'hex');
  if (envelope.cksum !== sha256(ciphertext) && envelope.cksum !== sha256(envelope.payload)) {
    const error = new Error('Checksum mismatch');
    error.status = 401;
    throw error;
  }
  const key = bankKey.computeSecret(Buffer.from(envelope.pubkey, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.salt, 'hex'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

const ft = () => `FT${Date.now().toString().slice(-10)}`;

function resultFor() {
  switch (OUTCOME) {
    case 'decline':
      return { statusCode: '1', statusDesc: 'Invalid PIN', cbsreference: '', paymentStatus: 'NOT_PAID' };
    case 'busy':
      return { statusCode: '1', statusDesc: 'server busy', cbsreference: ft(), paymentStatus: 'NOT_PAID' };
    case 'silent':
      return { paymentStatus: 'PENDING', silent: true };
    case 'silent-paid':
      return { statusCode: '0', statusDesc: 'Payment successful', cbsreference: ft(), paymentStatus: 'PAID', silent: true };
    default:
      return { statusCode: '0', statusDesc: 'Payment successful', cbsreference: ft(), paymentStatus: 'PAID' };
  }
}

async function postCallback(transactionRef) {
  const transfer = transfers.get(transactionRef);
  const { request, result } = transfer;
  transfer.answeredAt = new Date();
  if (result.silent) {
    console.log(`[mock] ${transactionRef}: no callback (MOCK_OUTCOME=${OUTCOME})`);
    return;
  }
  // §7.2 schema; §7.1 envelope with no reference in clear.
  const body = {
    transactionRef,
    statusDesc: result.statusDesc,
    statusCode: result.statusCode,
    cbsreference: result.cbsreference,
    company: request.company,
    amount: String(request.amount),
  };
  try {
    const res = await fetch(request.resultUrl || CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${CALLBACK_USERNAME}:${CALLBACK_PASSWORD}`).toString('base64')}`,
      },
      body: JSON.stringify(seal(PARTNER_PUBLIC_KEY || transfer.clientPublicKey, body)),
    });
    console.log(`[mock] ${transactionRef}: callback -> ${res.status} ${await res.text()}`);
  } catch (error) {
    console.error(`[mock] ${transactionRef}: callback failed: ${error.message}`);
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  return req.headers.authorization === `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return send(res, 401, { message: 'Unauthorized' });
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/nib-push-payment/api/get-pub-key') {
    return send(res, 200, { publicKey: bankPublicKey });
  }

  if (req.method === 'POST' && url.pathname === '/push-payment/transfer') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let envelope, request;
    try {
      envelope = JSON.parse(raw);
      request = open(envelope);
    } catch (error) {
      return send(res, error.status || 500, { message: error.status ? error.message : 'Decryption error' });
    }
    const reply = { transactionRef: request.transactionRef, customerPhone: request.customerPhone };
    if (transfers.has(request.transactionRef)) {
      return send(res, 409, { message: 'Duplicate transactionRef', statusCode: 409, ...reply });
    }
    if (String(request.customerPhone).endsWith('0000')) {
      return send(res, 400, { message: 'Unable to accept request', statusCode: 400, ...reply, details: 'User not found' });
    }
    console.log(
      `[mock] transfer ${request.transactionRef}: ${request.amount} ETB from ${request.customerPhone}` +
        ` to ${request.creditAccount || '(profile account)'}, company ${request.company}, "${request.merchantName}" / "${request.description}"`,
    );
    transfers.set(request.transactionRef, { clientPublicKey: envelope.pubkey, request, answeredAt: null, result: resultFor() });
    setTimeout(() => postCallback(request.transactionRef), CALLBACK_DELAY_MS);
    return send(res, 200, { message: 'Request accepted successfully', statusCode: 200, ...reply, details: 'USSD push message sent successfully.' });
  }

  const status = req.method === 'GET' && url.pathname.match(/^\/push-payment\/status\/([^/]+)$/);
  if (status) {
    const transactionRef = decodeURIComponent(status[1]);
    const transfer = transfers.get(transactionRef);
    if (!transfer) return send(res, 404, { message: 'transactionRef not found' });
    const answered = Boolean(transfer.answeredAt);
    const body = {
      transactionRef,
      customerPhone: transfer.request.customerPhone,
      amount: transfer.request.amount,
      paymentStatus: answered ? transfer.result.paymentStatus : 'PENDING',
      cbsreference: answered && transfer.result.cbsreference ? transfer.result.cbsreference : null,
      message: answered ? transfer.result.statusDesc : 'Awaiting customer action on USSD.',
      updatedAt: (transfer.answeredAt || new Date()).toISOString(),
    };
    console.log(`[mock] status ${transactionRef}: ${body.paymentStatus}`);
    return send(res, 200, seal(transfer.clientPublicKey, body));
  }

  send(res, 404, { message: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[mock] NIB push service on http://localhost:${PORT} (MOCK_OUTCOME=${OUTCOME}, checksum ${CHECKSUM}, callbacks to ${CALLBACK_URL})`);
  if (!PARTNER_PUBLIC_KEY) console.log('[mock] MOCK_PARTNER_PUBLIC_KEY not set: callbacks are encrypted to each transfer\'s one-time key');
});
