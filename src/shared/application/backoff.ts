import { randomInt } from 'node:crypto';
import { DomainError } from '../domain/domain-error.js';

const millisecondsPerSecond = 1_000n;
const maximumSafeMilliseconds = BigInt(Number.MAX_SAFE_INTEGER);

export type JitterBasisPoints = () => bigint;

export const randomJitterBasisPoints: JitterBasisPoints = () => BigInt(randomInt(8_000, 12_001));

/** Exponential delay with integer-only jitter in the inclusive [0.8, 1.2] range. */
export function exponentialBackoffMilliseconds(
  attempt: bigint,
  baseSeconds: bigint,
  maxSeconds: bigint,
  jitter: JitterBasisPoints = randomJitterBasisPoints,
): bigint {
  if (attempt < 1n || baseSeconds < 1n || maxSeconds < baseSeconds)
    throw new DomainError('INVALID_BACKOFF_CONFIGURATION');
  let delay = baseSeconds;
  let exponent = attempt - 1n;
  while (exponent > 0n && delay < maxSeconds) {
    delay = delay * 2n > maxSeconds ? maxSeconds : delay * 2n;
    exponent -= 1n;
  }
  const cap = maxSeconds * millisecondsPerSecond;
  const jittered = (delay * millisecondsPerSecond * jitter()) / 10_000n;
  return jittered > cap ? cap : jittered;
}

export function addMilliseconds(now: Date, milliseconds: bigint): Date {
  if (milliseconds > maximumSafeMilliseconds) throw new DomainError('DELAY_OUT_OF_RANGE');
  return new Date(now.getTime() + Number(milliseconds));
}
