// Composite group keys for the Analytical view. A key is stable across the in-memory and
// disk-backed paths because every part is normalised to a string (or null) before encoding.

export type GroupKeyPart = string | null;

export function normalizeKeyPart(value: unknown): GroupKeyPart {
    if (value === null || value === undefined) {
        return null;
    }
    return String(value);
}

export function encodeGroupKey(values: readonly unknown[]): string {
    return JSON.stringify(values.map(normalizeKeyPart));
}

export function decodeGroupKey(key: string): GroupKeyPart[] {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) ? parsed.map(part => (part === null ? null : String(part))) : [];
}

/**
 * Order two encoded keys the way the disk store does: by part, nulls last, then text ascending.
 * Both engines use this total order, so the "top N" list is identical for equal-sized groups.
 */
export function compareGroupKeys(a: string, b: string): number {
    const partsA = decodeGroupKey(a);
    const partsB = decodeGroupKey(b);
    const length = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < length; i++) {
        const va = partsA[i] ?? null;
        const vb = partsB[i] ?? null;
        if (va === vb) continue;
        if (va === null) return 1;
        if (vb === null) return -1;
        if (va < vb) return -1;
        if (va > vb) return 1;
    }
    return 0;
}

/** Human label for a group: null and empty values are made visible instead of blank. */
export function formatGroupLabel(values: readonly GroupKeyPart[]): string {
    return values
        .map(part => {
            if (part === null) return '(null)';
            if (part === '') return '(empty)';
            return part;
        })
        .join(' / ');
}
