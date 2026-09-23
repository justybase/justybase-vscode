export type RelatedColumnRole = 'foreign' | 'key' | 'unknown';

const PREFIXES = ['UK_', 'PK_', 'FK_', 'COL_'] as const;

export function normalizeRelatedColumnName(name: string): string {
    let normalized = name.trim().replace(/^"|"$/g, '').toUpperCase();
    let changed = true;
    while (changed) {
        changed = false;
        for (const prefix of PREFIXES) {
            if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
                normalized = normalized.slice(prefix.length);
                changed = true;
                break;
            }
        }
    }
    return normalized;
}

export function getRelatedColumnRole(column: {
    name: string;
    isPk?: boolean;
    isFk?: boolean;
}): RelatedColumnRole {
    let name = column.name.trim().replace(/^"|"$/g, '').toUpperCase();
    while (name.startsWith('COL_')) name = name.slice(4);
    if (column.isFk === true || name.startsWith('FK_')) return 'foreign';
    if (column.isPk === true || name.startsWith('PK_') || name.startsWith('UK_')) return 'key';
    return 'unknown';
}
