import { after, NextRequest, NextResponse } from 'next/server';
import { checkCallbackAuth, describeAuthorization } from '@/lib/nib-push/callback-auth';
import { handlePushCallback } from '@/lib/nib-push/push-payments';
import { notifyTelegramPaymentUpdate } from '@/lib/telegram/notifications';

/**
 * POST /api/nib-push/callback — the callback URL (resultUrl) registered with
 * the bank (guide §7, §10.1). It cannot be sent per request: the transfer
 * schema rejects a resultUrl field.
 *
 * Result of a NIB USSD push, posted by the bank once the transaction reaches
 * a terminal state. Body: { payload, pubkey, cksum, salt, tag } — the result
 * itself is encrypted (see src/lib/nib-push/crypto.ts).
 *
 * The bank proves who it is with the Basic credentials we gave it (§10.1),
 * or, before it has them, by encrypting with its own key (see handlePushCallback).
 * 200 processed (also for duplicates), 401 neither proof, 400 checksum or
 * decryption failure, 404 unknown reference.
 */
export async function POST(req: NextRequest) {
  const authorization = req.headers.get('authorization');
  const authenticated = checkCallbackAuth(authorization) === true;
  if (!authenticated) {
    // Enough to tell a missing header from a wrong password, never the password itself.
    console.warn('[nib-push] callback without valid Basic auth', {
      ...describeAuthorization(authorization),
      contentType: req.headers.get('content-type'),
      ip: req.headers.get('x-forwarded-for'),
    });
  }
  const body = await req.json().catch(() => null);
  try {
    const result = await handlePushCallback(body, { authenticated });
    if (result.transition) {
      const transition = result.transition;
      after(() => notifyTelegramPaymentUpdate(transition));
    }
    const headers: Record<string, string> = result.status === 401 ? { 'WWW-Authenticate': 'Basic' } : {};
    return NextResponse.json({ message: result.message }, { status: result.status, headers });
  } catch (error) {
    // 5xx so the bank redelivers the callback.
    console.error('[nib-push] callback processing failed', error);
    return NextResponse.json({ message: 'Internal processing error.' }, { status: 500 });
  }
}
