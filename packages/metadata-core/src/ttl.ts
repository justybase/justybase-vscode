import type { MetadataTtlState } from './types';

export const STALE_TTL_MULTIPLIER = 2;

export function computeStaleTtl(freshTtl: number): number {
  return freshTtl * STALE_TTL_MULTIPLIER;
}

export function classifyTtl(
  timestamp: number,
  now: number,
  freshTtl: number,
  staleTtl = computeStaleTtl(freshTtl),
): MetadataTtlState {
  const age = now - timestamp;
  if (age < freshTtl) return 'fresh';
  if (age < staleTtl) return 'stale';
  return 'expired';
}

export function isFresh(timestamp: number, now: number, freshTtl: number): boolean {
  return classifyTtl(timestamp, now, freshTtl) === 'fresh';
}

export function isServable(timestamp: number, now: number, freshTtl: number, staleTtl = computeStaleTtl(freshTtl)): boolean {
  return classifyTtl(timestamp, now, freshTtl, staleTtl) !== 'expired';
}
