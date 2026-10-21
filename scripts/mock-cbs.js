/**
 * Fake core-banking (CBS) transfer endpoint for local testing.
 *
 * Point EXTERNAL_DISBURSEMENT_URL (or only AFFILIATE_PAYOUT_URL) at it while
 * testing, so loan disbursements, BNPL merchant payments and affiliate payouts
 * never reach the real bank. Every request is printed to the console.
 *
 *   node scripts/mock-cbs.js              every transfer succeeds (HTTP 200 + transactionId)
 *   node scripts/mock-cbs.js fail         every transfer fails (HTTP 500)
 *   node scripts/mock-cbs.js success 4011 choose another port (default 4010)
 */
const http = require('http');

const mode = process.argv[2] === 'fail' ? 'fail' : 'success';
const port = Number(process.argv[3]) || 4010;
let count = 0;

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      count += 1;
      console.log(`[mock-cbs] #${count} ${req.method} ${req.url} ${body}`);
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'fail') {
        res.statusCode = 500;
        res.end(JSON.stringify({ status: 'FAILED', message: 'Mock CBS failure' }));
        return;
      }
      res.end(JSON.stringify({ status: 'SUCCESS', transactionId: `MOCK-${Date.now()}-${count}` }));
    });
  })
  .listen(port, () => {
    console.log(`[mock-cbs] listening on http://localhost:${port} (every transfer will ${mode === 'fail' ? 'FAIL' : 'SUCCEED'})`);
  });
