import { describe, expect, test } from 'vitest';
import { computeInitDataHash, InitDataError, validateInitData } from './init-data';

const BOT_TOKEN = '123456:TEST-token';
const NOW = new Date('2026-10-20T09:00:00Z');
const AUTH_DATE = Math.floor(NOW.getTime() / 1000) - 60;

function signedInitData(fields: Record<string, string>, token = BOT_TOKEN) {
  const params = new URLSearchParams(fields);
  params.set('hash', computeInitDataHash(params, token));
  return params.toString();
}

const user = JSON.stringify({ id: 5550001234, first_name: 'Abebe', username: 'abebe' });
const options = { maxAgeSeconds: 3600, now: NOW };

describe('validateInitData', () => {
  test('accepts correctly signed data and returns the user and start_param', () => {
    const raw = signedInitData({ auth_date: String(AUTH_DATE), user, query_id: 'AAH', start_param: 'item_abc' });
    const result = validateInitData(raw, BOT_TOKEN, options);
    expect(result.user.id).toBe(5550001234);
    expect(result.startParam).toBe('item_abc');
    expect(result.queryId).toBe('AAH');
  });

  test('keeps the signature field in the data-check-string', () => {
    const raw = signedInitData({ auth_date: String(AUTH_DATE), user, signature: 'c2lnbmF0dXJl' });
    expect(() => validateInitData(raw, BOT_TOKEN, options)).not.toThrow();
  });

  test('rejects data signed with a different bot token', () => {
    const raw = signedInitData({ auth_date: String(AUTH_DATE), user }, '999:other');
    expect(() => validateInitData(raw, BOT_TOKEN, options)).toThrow(InitDataError);
  });

  test('rejects tampered fields', () => {
    const raw = signedInitData({ auth_date: String(AUTH_DATE), user });
    const tampered = raw.replace('5550001234', '5550009999');
    expect(() => validateInitData(tampered, BOT_TOKEN, options)).toThrow(/signature/);
  });

  test('rejects expired data', () => {
    const raw = signedInitData({ auth_date: String(AUTH_DATE - 7200), user });
    expect(() => validateInitData(raw, BOT_TOKEN, options)).toThrow(/expired/);
  });

  test('rejects missing or malformed hash', () => {
    expect(() => validateInitData(`auth_date=${AUTH_DATE}&user=${encodeURIComponent(user)}`, BOT_TOKEN, options)).toThrow(/hash/);
    expect(() => validateInitData(`auth_date=${AUTH_DATE}&hash=xyz`, BOT_TOKEN, options)).toThrow(/hash/);
    expect(() => validateInitData('', BOT_TOKEN, options)).toThrow(InitDataError);
  });

  test('rejects signed data without a user', () => {
    const raw = signedInitData({ auth_date: String(AUTH_DATE) });
    expect(() => validateInitData(raw, BOT_TOKEN, options)).toThrow(/user/);
  });
});
