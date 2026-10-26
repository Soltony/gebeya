import { NextRequest, NextResponse } from 'next/server';
import { checkCallbackAuth } from '@/lib/nib-push/callback-auth';
import { getServerPrivateKey, NibPushConfigError } from '@/lib/nib-push/config';
import { publicKeyFromPrivate } from '@/lib/nib-push/crypto';

/**
 * GET /api/nib-push/public-key — our public key for the bank to pull (guide
 * §10.2 Option A), protected by the same Basic auth as the callback. The
 * bank uses it to encrypt callbacks. Body: { publicKey } (base64, uncompressed).
 */
export async function GET(req: NextRequest) {
  const authorized = checkCallbackAuth(req.headers.get('authorization'));
  if (authorized === null) return NextResponse.json({ message: 'Not configured.' }, { status: 503 });
  if (!authorized) {
    return NextResponse.json({ message: 'Unauthorized.' }, { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
  }

  try {
    const privateKey = getServerPrivateKey();
    if (!privateKey) return NextResponse.json({ message: 'Not configured.' }, { status: 503 });
    return NextResponse.json({ publicKey: publicKeyFromPrivate(privateKey) });
  } catch (error) {
    if (error instanceof NibPushConfigError) {
      console.error('[nib-push] NIB_PUSH_SERVER_PRIVATE_KEY is invalid:', error.message);
      return NextResponse.json({ message: 'Not configured.' }, { status: 503 });
    }
    throw error;
  }
}
