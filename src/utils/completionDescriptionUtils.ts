const MAX_INLINE_DESCRIPTION_LENGTH = 96;

/** Separator between the structured detail and the catalog comment. */
const DETAIL_SEPARATOR = " · ";

export function normalizeCompletionDescription(
  description: unknown,
): string | undefined {
  if (typeof description !== "string") {
    return undefined;
  }
  const trimmed = description.trim();
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

/**
 * Folds a catalog comment into a completion detail line.
 *
 * VS Code renders `CompletionItem.labelDetails` by turning the label into a
 * label object, which removes `detail` from the suggest row: a commented column
 * then only showed the comment and lost its data type, and a commented table
 * lost its type, schema and row estimate. Merging both into `detail` keeps the
 * structured facts (`INTEGER`, `TABLE (ADMIN) · ~4k rows`) visible next to the
 * comment, separated by the same `·` the row estimate already uses.
 */
export function mergeCompletionDetail(
  detail: string | undefined,
  description: string | undefined,
): string | undefined {
  const facts = typeof detail === "string" ? detail.trim() : "";
  const inline = toInlineCompletionDescription(description);
  if (!facts) {
    return inline;
  }
  if (!inline) {
    return facts;
  }
  return `${facts}${DETAIL_SEPARATOR}${inline}`;
}
