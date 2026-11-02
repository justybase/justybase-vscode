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

const KEY_SUFFIX = /^(.*?)_?(?:ID|KEY|SK|NO|NUM|CODE)$/;

function compactName(name: string): string {
    return name.trim().replace(/^"|"$/g, '').toUpperCase().replace(/_/g, '');
}

/**
 * Stem of a key-shaped column name (`PRODUCT_ID` → `PRODUCT`,
 * `ORDERDATEKEY` → `ORDERDATE`), or undefined when the name has no key suffix.
 */
export function keyColumnStem(column: string): string | undefined {
    const match = KEY_SUFFIX.exec(normalizeRelatedColumnName(column));
    const stem = match ? match[1].replace(/_/g, '') : '';
    return stem.length >= 3 ? stem : undefined;
}

/**
 * Whether a column is named after its own table, the surrogate/natural key
 * convention of star schemas: `DIMPRODUCT.PRODUCTKEY`, `MIS_DIM_BRANCH.BRANCH_ID`,
 * `CUSTOMERS.CUSTOMER_ID`. Prefixes such as `DIM`/`MIS_DIM_` are tolerated
 * because the table name only has to end with the column stem.
 */
export function isSelfNamedKeyColumn(column: string, table: string): boolean {
    const stem = keyColumnStem(column);
    if (!stem) return false;
    const compactTable = compactName(table);
    return compactTable.endsWith(stem)
        || compactTable.endsWith(`${stem}S`)
        || compactTable.endsWith(`${stem}ES`)
        || (stem.endsWith('Y') && compactTable.endsWith(`${stem.slice(0, -1)}IES`));
}
