const MAX_INLINE_DESCRIPTION_LENGTH = 96;

export function normalizeCompletionDescription(
  description: string | undefined,
): string | undefined {
  const trimmed = description?.trim();
  return trimmed || undefined;
}

/** Short text shown inline in the suggest list when an item is focused. */
export function toInlineCompletionDescription(
  description: string | undefined,
): string | undefined {
  const normalized = normalizeCompletionDescription(description);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_INLINE_DESCRIPTION_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_INLINE_DESCRIPTION_LENGTH - 1)}…`;
}
