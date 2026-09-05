import { expect, test } from 'bun:test';
import {
  addMilliseconds,
  exponentialBackoffMilliseconds,
} from '../../src/shared/application/backoff.js';

test('uses exact integer exponential backoff with injectable jitter', () => {
  const noJitter = () => 10_000n;
  expect(exponentialBackoffMilliseconds(1n, 5n, 3_600n, noJitter)).toBe(5_000n);
  expect(exponentialBackoffMilliseconds(3n, 5n, 3_600n, noJitter)).toBe(20_000n);
  expect(exponentialBackoffMilliseconds(20n, 5n, 60n, noJitter)).toBe(60_000n);
  expect(exponentialBackoffMilliseconds(20n, 5n, 60n, () => 12_000n)).toBe(60_000n);
  expect(addMilliseconds(new Date('2026-09-04T00:00:00.000Z'), 5_000n).toISOString()).toBe(
    '2026-09-04T00:00:05.000Z',
  );
});
