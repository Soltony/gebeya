import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// A fresh module per test: the outage window is module state.
async function loadClient() {
  vi.resetModules();
  return import('./client');
}

const timeout = (): Promise<Response> => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  Object.assign(process.env, {
    NIB_PUSH_BASE_URL: 'http://bank.test',
    NIB_PUSH_USERNAME: 'nib',
    NIB_PUSH_PASSWORD: 'secret',
    NIB_PUSH_COMPANY: 'GEBYA',
  });
  delete process.env.NIB_PUSH_BANK_PUBLIC_KEY;
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('when the bank stops answering (UAT gateway outages)', () => {
  test('a status check that times out is not retried, and the next ones are skipped for 30 s', async () => {
    const client = await loadClient();
    const fetchMock = vi.fn(timeout);
    vi.stubGlobal('fetch', fetchMock);

    await expect(client.getTransferStatus('ref1')).rejects.toBeInstanceOf(client.NibPushNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(client.getTransferStatus('ref2')).rejects.toBeInstanceOf(client.NibPushUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.isNibPushServiceDown('push')).toBe(true);

    vi.setSystemTime(Date.now() + 31_000);
    fetchMock.mockImplementation(() => json(200, { payload: 'ab' }));
    await expect(client.getTransferStatus('ref3')).resolves.toMatchObject({ status: 200 });
    expect(client.isNibPushServiceDown('push')).toBe(false);
  });

  test('a key-service outage does not stop calls to the push service', async () => {
    const client = await loadClient();
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.includes('get-pub-key') ? timeout() : json(200, {}))));

    await expect(client.getProviderPublicKey()).rejects.toBeInstanceOf(client.NibPushNetworkError);
    expect(client.isNibPushServiceDown('key')).toBe(true);
    await expect(client.getTransferStatus('ref1')).resolves.toMatchObject({ status: 200 });
  });

  test('while the key service is down, the fallback key is used without waiting on it', async () => {
    process.env.NIB_PUSH_BANK_PUBLIC_KEY = 'BANKKEY';
    const client = await loadClient();
    const fetchMock = vi.fn(timeout);
    vi.stubGlobal('fetch', fetchMock);

    expect(await client.getProviderPublicKey()).toEqual({ key: 'BANKKEY', fromCache: true });
    expect(await client.getProviderPublicKey()).toEqual({ key: 'BANKKEY', fromCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
