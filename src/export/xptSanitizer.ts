/**
 * SAS XPORT v5 name/label sanitizer.
 *
 * SAS names:
 *  - Max 8 characters
 *  - Valid chars: A-Z, 0-9, underscore
 *  - Must start with letter or underscore
 *  - Automatically uppercased
 *
 * SAS labels:
 *  - Max 40 characters
 */

const MAX_SAS_NAME = 8;
const MAX_SAS_LABEL = 40;
const VALID_NAME_RE = /[^A-Z0-9_]/g;
const LEADING_DIGIT_RE = /^[0-9]/;

export interface SanitizationWarning {
    type: 'truncated' | 'renamed' | 'cleaned';
    original: string;
    result: string;
    message: string;
}

/**
 * Sanitize a single SAS variable name.
 * Ensures it is uppercase, contains only valid characters, starts with
 * a letter or underscore, and is at most 8 characters.
 */
export function sanitizeSasName(original: string): {
    name: string;
    warnings: SanitizationWarning[];
} {
    const warnings: SanitizationWarning[] = [];
    let cleaned = original.toUpperCase().replace(VALID_NAME_RE, '');
    if (cleaned !== original.toUpperCase()) {
        warnings.push({
            type: 'cleaned',
            original,
            result: cleaned,
            message: `Column "${original}": cleaned to "${cleaned}"`,
        });
    }

    // Must not start with a digit.
    if (LEADING_DIGIT_RE.test(cleaned)) {
        cleaned = '_' + cleaned;
    }

    // Must not be empty.
    if (cleaned.length === 0) {
        cleaned = '_COL';
    }

    // Truncate.
    if (cleaned.length > MAX_SAS_NAME) {
        warnings.push({
            type: 'truncated',
            original,
            result: cleaned.slice(0, MAX_SAS_NAME),
            message: `Column "${original}" truncated to "${cleaned.slice(0, MAX_SAS_NAME)}"`,
        });
        cleaned = cleaned.slice(0, MAX_SAS_NAME);
    }

    return { name: cleaned, warnings };
}

/**
 * Sanitize a SAS label (max 40 chars, no special rules beyond length).
 */
export function sanitizeSasLabel(original: string): string {
    return original.length > MAX_SAS_LABEL
        ? original.slice(0, MAX_SAS_LABEL)
        : original;
}

/**
 * Resolve a set of original column names into unique, SAS-compliant names
 * (max 8 chars, deduplicated).
 *
 * Deduplication strategy: on conflict, append `_n` where `n` is 1..9,
 * then `_A`..`_Z`. If still conflicting (unlikely), falls back to
 * `_<counter>`.
 */
export function resolveSasColumnNames(
    originalNames: string[],
): { names: string[]; warnings: SanitizationWarning[] } {
    const warnings: SanitizationWarning[] = [];
    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const original of originalNames) {
        const { name: base, warnings: sw } = sanitizeSasName(original);
        warnings.push(...sw);

        let candidate = base;
        if (seen.has(candidate)) {
            // Find a suffix that makes it unique, keeping ≤ 8 chars.
            candidate = makeUnique(candidate, seen, base);
        }

        if (candidate !== original) {
            warnings.push({
                type: 'renamed',
                original,
                result: candidate,
                message: `Column "${original}" → "${candidate}" (SAS name)`,
            });
        }

        seen.add(candidate);
        resolved.push(candidate);
    }

    return { names: resolved, warnings };
}

function makeUnique(
    candidate: string,
    seen: Set<string>,
    base: string,
): string {
    // Try numeric suffixes 1..9
    for (let i = 1; i <= 9; i++) {
        const suffix = String(i);
        const tryName =
            candidate.length + suffix.length <= MAX_SAS_NAME
                ? candidate + suffix
                : candidate.slice(0, MAX_SAS_NAME - suffix.length) + suffix;
        if (!seen.has(tryName)) return tryName;
    }

    // Try alphabetic suffixes A..Z
    for (let i = 0; i < 26; i++) {
        const suffix = String.fromCharCode(65 + i); // A..Z
        const tryName =
            candidate.length + 1 <= MAX_SAS_NAME
                ? candidate + suffix
                : candidate.slice(0, MAX_SAS_NAME - 1) + suffix;
        if (!seen.has(tryName)) return tryName;
    }

    // Fallback: _0 .. _99
    for (let i = 0; i < 100; i++) {
        const suffix = `_${i}`;
        const tryName =
            candidate.length + suffix.length <= MAX_SAS_NAME
                ? candidate + suffix
                : candidate.slice(0, MAX_SAS_NAME - suffix.length) + suffix;
        if (!seen.has(tryName)) return tryName;
    }

    // Should never get here, but just in case:
    return base.slice(0, MAX_SAS_NAME);
}
