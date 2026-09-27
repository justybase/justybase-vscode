import type { DatabaseForeignKeyColumnReference } from '../contracts/database';

export interface RawForeignKeyRelationshipRow extends Record<string, unknown> {
    FROM_DATABASE?: unknown;
    FROM_SCHEMA?: unknown;
    FROM_TABLE?: unknown;
    FROM_COLUMN?: unknown;
    TO_DATABASE?: unknown;
    TO_SCHEMA?: unknown;
    TO_TABLE?: unknown;
    TO_COLUMN?: unknown;
    CONSTRAINT_NAME?: unknown;
    ORDINAL_POSITION?: unknown;
}

export interface ForeignKeyTableIdentity {
    database: string;
    schema: string;
    table: string;
}

/** One database's FK catalog result stored in the metadata cache. */
export interface ForeignKeyRelationshipCacheSlice {
    database: string;
    references: DatabaseForeignKeyColumnReference[];
    /** False when the catalog query failed or only a partial scope was scanned. */
    complete: boolean;
}

function catalogText(value: unknown): string {
    return String(value ?? '').trimEnd();
}

function normalizedPart(value: unknown): string {
    // Values come from Netezza catalogs, where mixed-case quoted identifiers
    // are significant. Remove catalog padding without folding identifier case.
    return String(value ?? '').trimEnd();
}

function compareText(left: string | undefined, right: string | undefined): number {
    const a = String(left ?? '');
    const b = String(right ?? '');
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Convert catalog rows into complete, source-to-target FK column mappings. */
export function normalizeForeignKeyRelationshipRows(
    rows: readonly RawForeignKeyRelationshipRow[],
    fallbackDatabase: string,
): DatabaseForeignKeyColumnReference[] {
    const references: DatabaseForeignKeyColumnReference[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
        const fromDatabase = catalogText(row.FROM_DATABASE) || fallbackDatabase;
        const fromSchema = catalogText(row.FROM_SCHEMA);
        const fromTable = catalogText(row.FROM_TABLE);
        const fromColumn = catalogText(row.FROM_COLUMN);
        const toDatabase = catalogText(row.TO_DATABASE) || fromDatabase;
        const toSchema = catalogText(row.TO_SCHEMA);
        const toTable = catalogText(row.TO_TABLE);
        const toColumn = catalogText(row.TO_COLUMN);

        if (!fromDatabase || !fromSchema || !fromTable || !fromColumn || !toSchema || !toTable || !toColumn) {
            continue;
        }

        const constraintName = catalogText(row.CONSTRAINT_NAME) || undefined;
        const ordinal = Number(row.ORDINAL_POSITION);
        const ordinalPosition = Number.isFinite(ordinal) ? ordinal : undefined;
        const reference: DatabaseForeignKeyColumnReference = {
            fromDatabase,
            fromSchema,
            fromTable,
            fromColumn,
            toDatabase,
            toSchema,
            toTable,
            toColumn,
            constraintName,
            ordinalPosition,
        };
        const identity = JSON.stringify([
            fromDatabase, fromSchema, fromTable, fromColumn,
            toDatabase, toSchema, toTable, toColumn,
            constraintName ?? '', ordinalPosition ?? '',
        ].map(normalizedPart));
        if (!seen.has(identity)) {
            seen.add(identity);
            references.push(reference);
        }
    }

    return references.sort((left, right) =>
        compareText(left.fromDatabase, right.fromDatabase)
        || compareText(left.fromSchema, right.fromSchema)
        || compareText(left.fromTable, right.fromTable)
        || compareText(left.constraintName, right.constraintName)
        || (left.ordinalPosition ?? Number.MAX_SAFE_INTEGER) - (right.ordinalPosition ?? Number.MAX_SAFE_INTEGER)
        || compareText(left.fromColumn, right.fromColumn));
}

export function sameForeignKeyTable(
    left: ForeignKeyTableIdentity,
    right: ForeignKeyTableIdentity,
): boolean {
    return normalizedPart(left.database) === normalizedPart(right.database)
        && normalizedPart(left.schema) === normalizedPart(right.schema)
        && normalizedPart(left.table) === normalizedPart(right.table);
}

export function getForeignKeyReferencesForTable(
    references: readonly DatabaseForeignKeyColumnReference[],
    table: ForeignKeyTableIdentity,
): DatabaseForeignKeyColumnReference[] {
    return references.filter(reference => sameForeignKeyTable({
        database: reference.fromDatabase ?? '',
        schema: reference.fromSchema,
        table: reference.fromTable,
    }, table));
}

export function getForeignKeyReferencingTable(
    references: readonly DatabaseForeignKeyColumnReference[],
    table: ForeignKeyTableIdentity,
): DatabaseForeignKeyColumnReference[] {
    return references.filter(reference => sameForeignKeyTable({
        database: reference.toDatabase ?? reference.fromDatabase ?? '',
        schema: reference.toSchema,
        table: reference.toTable,
    }, table));
}
