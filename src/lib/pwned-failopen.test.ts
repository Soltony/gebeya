import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPwnedPassword, passwordSchema } from './validators';

const tlsFailure = () => {
  const err: any = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('self-signed certificate in certificate chain'), {
    code: 'SELF_SIGNED_CERT_IN_CHAIN',
  });
  return Promise.reject(err);
};

afterEach(() => vi.unstubAllGlobals());

describe('isPwnedPassword fail-open', () => {
  it('returns false instead of throwing when the HIBP fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(tlsFailure));
    await expect(isPwnedPassword('Str0ng!Passw0rd')).resolves.toBe(false);
  });

  it('lets a strong password validate when HIBP is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(tlsFailure));
    const result = await passwordSchema.safeParseAsync('Str0ng!Passw0rd');
    expect(result.success).toBe(true);
  });

  it('still rejects a weak password when HIBP is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(tlsFailure));
    const result = await passwordSchema.safeParseAsync('password');
    expect(result.success).toBe(false);
  });
});
