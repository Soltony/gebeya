import { describe, expect, test } from 'vitest';
import { maskPhone, normalizeEthiopianPhone } from './phone';

describe('normalizeEthiopianPhone', () => {
  test.each([
    ['+251962206017', '251962206017'],
    ['251962206017', '251962206017'],
    ['0962206017', '251962206017'],
    ['962206017', '251962206017'],
    ['+251 712 345 678', '251712345678'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeEthiopianPhone(input)).toBe(expected);
  });

  test.each([['+254712345678'], ['+251112345678'], ['12345'], [''], [null], [undefined]])('rejects %s', input => {
    expect(normalizeEthiopianPhone(input as any)).toBeNull();
  });
});

describe('maskPhone', () => {
  test('keeps the country code and last four digits', () => {
    expect(maskPhone('251962206017')).toBe('2519****6017');
  });
});
