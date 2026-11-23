/**
 * Plans the DuckDB keys that reproduce Microsoft Access index semantics.
 *
 * Access compares text key values case-insensitively and ignores trailing
 * spaces, so a plain DuckDB `UNIQUE`/`PRIMARY KEY` constraint is not
 * equivalent: it treats `'a'` and `'A'` (and `'a '`) as different values.  The
 * only construction verified to match DAO 16 is a unique index over
 * `lower(rtrim(column, ' '))`:
 *
 *   'a' vs 'A'    -> duplicate (rejected)
 *   'a' vs 'a '   -> duplicate (rejected)
 *   'a' vs ' a'   -> distinct  (accepted)
 *   '' vs ' '     -> duplicate (rejected)
 *
 * Non-text components keep their binary comparison, so a composite key mixes
 * both expressions.  Keys made only of non-text columns are emitted as real
 * table constraints, which also keeps the schema readable.
 */

import type {
    AccessColumnDefinition,
    AccessIndexDefinition,
    AccessTableDefinition,
} from '@justybase/access-file';

export type AccessMirrorKeyKind = 'primary-key' | 'unique';

export interface AccessMirrorKeyPlan {
    /** Index name inside the DuckDB mirror (Access index names are not unique). */
    readonly name: string;
    readonly kind: AccessMirrorKeyKind;
    /** Access index this plan reproduces, kept for diagnostics. */
    readonly accessIndex: string;
    readonly columns: readonly string[];
    /** Expression per key column, in index order. */
    readonly expressions: readonly string[];
    /** True when the key can be a table constraint instead of an index. */
    readonly asConstraint: boolean;
}

export interface AccessMirrorKeyPlanResult {
    readonly keys: readonly AccessMirrorKeyPlan[];
    /** Columns that must be `NOT NULL` because the index disallows NULL. */
    readonly requiredColumns: readonly string[];
    readonly warnings: readonly string[];
}

/** Access cannot index these types, so a stored index on them is structural. */
const COMPLEX_TYPES = new Set(['complex']);
const UNINDEXABLE_TYPES = new Set(['memo', 'ole']);

const TEXT_TYPES = new Set(['text', 'memo', 'repid']);

export function isAccessTextColumn(column: AccessColumnDefinition): boolean {
    return TEXT_TYPES.has(column.accessType);
}

/** Index expression that reproduces Access text comparison for one column. */
export function accessMirrorKeyExpression(column: AccessColumnDefinition): string {
    const identifier = `"${column.name.replace(/"/g, '""')}"`;
    return isAccessTextColumn(column)
        ? `lower(rtrim(${identifier}, ' '))`
        : identifier;
}

function hashedMirrorName(tableName: string, indexName: string): string {
    const source = `${tableName}\u0000${indexName}`;
    let hash = 2166136261;
    for (const character of source) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
    }
    return `__access_key_${(hash >>> 0).toString(16)}`;
}

/**
 * Builds the key plan for one mirrored table.
 *
 * Plain (non-unique) indexes are not constraints and are skipped here; the
 * schema browser reads them from the file itself.
 */
export function planAccessMirrorKeys(
    definition: AccessTableDefinition,
    indexes: readonly AccessIndexDefinition[],
): AccessMirrorKeyPlanResult {
    const keys: AccessMirrorKeyPlan[] = [];
    const requiredColumns = new Set<string>();
    const warnings: string[] = [];
    const columnsByName = new Map(
        definition.columns.map(column => [column.name.toLowerCase(), column]),
    );

    for (const index of indexes) {
        const isKey = index.primaryKey || index.unique;
        if (!isKey && !index.required) {
            continue;
        }
        if (index.columns.length === 0) {
            if (isKey) {
                warnings.push(
                    `Table '${definition.name}' was mirrored without index '${index.name}': the index has no columns.`,
                );
            }
            continue;
        }
        const columns = index.columns.map(name => columnsByName.get(name.toLowerCase()));
        const missing = index.columns.filter((_name, position) => !columns[position]);
        if (missing.length > 0) {
            if (isKey) {
                warnings.push(
                    `Table '${definition.name}' was mirrored without index '${index.name}': `
                    + `the file lists unknown column(s) ${missing.join(', ')}.`,
                );
            }
            continue;
        }
        const resolved = columns as AccessColumnDefinition[];
        if (index.primaryKey || index.required) {
            // `WITH DISALLOW NULL` rejects a NULL in any key component, and a
            // primary key always does; Access then reports "Index or primary
            // key can't contain a Null value".  This applies to non-unique
            // indexes too, so it is decided before the key is considered.
            for (const column of resolved) {
                if (!COMPLEX_TYPES.has(column.accessType)) {
                    // Complex columns keep a required supporting index for
                    // their child-table bookkeeping, but an empty multivalue
                    // field is stored as a NULL parent pointer; making it NOT
                    // NULL would reject a value Access accepts.
                    requiredColumns.add(column.name);
                }
            }
        }
        if (!isKey) {
            continue;
        }
        if (resolved.some(column => COMPLEX_TYPES.has(column.accessType))) {
            // Complex columns carry an internal per-value index in the file.
            // It is not a user constraint and DuckDB cannot index the envelope.
            continue;
        }
        if (resolved.some(column => UNINDEXABLE_TYPES.has(column.accessType))) {
            warnings.push(
                `Table '${definition.name}' was mirrored without index '${index.name}': `
                + 'Access cannot index MEMO/OLE columns, so this index is not enforced.',
            );
            continue;
        }

        keys.push({
            name: hashedMirrorName(definition.name, index.name),
            kind: index.primaryKey ? 'primary-key' : 'unique',
            accessIndex: index.name,
            columns: resolved.map(column => column.name),
            expressions: resolved.map(accessMirrorKeyExpression),
            asConstraint: resolved.every(column => !isAccessTextColumn(column)),
        });
    }

    return { keys, requiredColumns: Array.from(requiredColumns), warnings };
}

/** `CONSTRAINT ... PRIMARY KEY (...) / UNIQUE (...)` clause for one plan. */
export function accessMirrorKeyConstraintSql(key: AccessMirrorKeyPlan): string {
    const columns = key.columns.map(column => `"${column.replace(/"/g, '""')}"`).join(', ');
    const constraint = key.kind === 'primary-key' ? 'PRIMARY KEY' : 'UNIQUE';
    return `CONSTRAINT "${key.name}" ${constraint} (${columns})`;
}

/** `CREATE UNIQUE INDEX ...` for a key that cannot be a table constraint. */
export function accessMirrorKeyIndexSql(
    tableName: string,
    key: AccessMirrorKeyPlan,
): string {
    const table = `"${tableName.replace(/"/g, '""')}"`;
    return `CREATE UNIQUE INDEX "${key.name}" ON ${table} (${key.expressions.join(', ')})`;
}
