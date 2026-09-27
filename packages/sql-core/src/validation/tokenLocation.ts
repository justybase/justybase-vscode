/**
 * Chevrotain 13 uses -1 for token positions that are unavailable (for example
 * parser EOF and recovery-inserted tokens). Treat those values like the NaN
 * sentinels used by Chevrotain 12 while keeping source offset 0 valid.
 */
export function getAvailableTokenLocation(
  value: number | undefined,
): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function getTokenLocationOr(
  value: number | undefined,
  fallback: number,
): number {
  return getAvailableTokenLocation(value) ?? fallback;
}

export function hasUnavailableTokenLocation(
  value: number | undefined,
): boolean {
  return value !== undefined && getAvailableTokenLocation(value) === undefined;
}
