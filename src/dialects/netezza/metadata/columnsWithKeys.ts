import type {
    DatabaseColumnsWithKeysQuerySet,
} from '../../../contracts/database';
import type { NetezzaIdentifier } from './identifierUtils';
import { NZ_QUERIES } from './systemQueries';

export type ColumnsWithKeysQueryRole = 'columns' | 'keys' | 'distribution';

export interface NetezzaColumnsWithKeysQueryOptions {
    schema?: string | NetezzaIdentifier;
    tableName?: string | NetezzaIdentifier;
    objTypes?: string[];
}

export interface NetezzaColumnsWithKeysRow extends Record<string, unknown> {
    OBJID?: unknown;
    TABLENAME?: unknown;
    SCHEMA?: unknown;
    DBNAME?: unknown;
    ATTNAME?: unknown;
    FORMAT_TYPE?: unknown;
    ATTNUM?: unknown;
    DESCRIPTION?: unknown;
    IS_PK?: unknown;
    IS_FK?: unknown;
    IS_DISTRIBUTION_KEY?: unknown;
}

/** Build the three independent Netezza catalog scans for column metadata. */
export function buildNetezzaColumnsWithKeysQueries(
    database: string | NetezzaIdentifier,
    options?: NetezzaColumnsWithKeysQueryOptions,
): DatabaseColumnsWithKeysQuerySet {
    return {
        columns: NZ_QUERIES.listColumnsWithKeys(database, options),
        keys: NZ_QUERIES.listColumnKeyFlags(database, options),
        distribution: NZ_QUERIES.listColumnDistributionFlags(database, options),
    };
}

function joinPart(value: unknown, trimCatalogPadding = false): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const text = String(value);
    return trimCatalogPadding ? text.trimEnd() : text.trim();
}

function columnJoinKey(row: Record<string, unknown>): string | undefined {
    const objectId = joinPart(row.OBJID);
    const columnName = joinPart(row.ATTNAME, true);
    if (objectId === undefined || columnName === undefined) {
        return undefined;
    }
    return JSON.stringify([objectId, columnName]);
}

function groupedColumnKey(row: NetezzaColumnsWithKeysRow): string {
    return JSON.stringify([
        row.TABLENAME,
        row.SCHEMA,
        row.DBNAME,
        row.ATTNAME,
        row.FORMAT_TYPE,
        row.ATTNUM,
        row.DESCRIPTION,
    ]);
}

function compareText(left: unknown, right: unknown): number {
    const leftText = String(left ?? '');
    const rightText = String(right ?? '');
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareAttnum(left: unknown, right: unknown): number {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
    }
    return compareText(left, right);
}

/**
 * Reproduce the old LEFT JOIN + GROUP BY + MAX result entirely in memory.
 */
export function mergeNetezzaColumnsWithKeysRows(
    columnRows: readonly NetezzaColumnsWithKeysRow[],
    keyRows: readonly Record<string, unknown>[],
    distributionRows: readonly Record<string, unknown>[],
): NetezzaColumnsWithKeysRow[] {
    const primaryKeys = new Set<string>();
    const foreignKeys = new Set<string>();
    const distributionKeys = new Set<string>();

    for (const row of keyRows) {
        const key = columnJoinKey(row);
        if (!key) {
            continue;
        }
        const constraintType = String(row.CONTYPE ?? '').trim();
        if (constraintType === 'p') {
            primaryKeys.add(key);
        } else if (constraintType === 'f') {
            foreignKeys.add(key);
        }
    }

    for (const row of distributionRows) {
        const key = columnJoinKey(row);
        if (key) {
            distributionKeys.add(key);
        }
    }

    const groupedRows = new Map<string, NetezzaColumnsWithKeysRow>();
    for (const row of columnRows) {
        const joinKey = columnJoinKey(row);
        const isPk = joinKey && primaryKeys.has(joinKey) ? 1 : 0;
        const isFk = joinKey && foreignKeys.has(joinKey) ? 1 : 0;
        const isDistributionKey = joinKey && distributionKeys.has(joinKey) ? 1 : 0;
        const groupKey = groupedColumnKey(row);
        const existing = groupedRows.get(groupKey);
        if (existing) {
            existing.IS_PK = Math.max(Number(existing.IS_PK), isPk);
            existing.IS_FK = Math.max(Number(existing.IS_FK), isFk);
            existing.IS_DISTRIBUTION_KEY = Math.max(
                Number(existing.IS_DISTRIBUTION_KEY),
                isDistributionKey,
            );
            continue;
        }

        groupedRows.set(groupKey, {
            TABLENAME: row.TABLENAME,
            SCHEMA: row.SCHEMA,
            DBNAME: row.DBNAME,
            ATTNAME: row.ATTNAME,
            FORMAT_TYPE: row.FORMAT_TYPE,
            ATTNUM: row.ATTNUM,
            DESCRIPTION: row.DESCRIPTION,
            IS_PK: isPk,
            IS_FK: isFk,
            IS_DISTRIBUTION_KEY: isDistributionKey,
        });
    }

    return [...groupedRows.values()].sort((left, right) =>
        compareText(left.SCHEMA, right.SCHEMA)
        || compareText(left.TABLENAME, right.TABLENAME)
        || compareAttnum(left.ATTNUM, right.ATTNUM));
}

/** Execute the three catalog scans serially and return the merged legacy row shape. */
export async function loadNetezzaColumnsWithKeysRows(
    queries: DatabaseColumnsWithKeysQuerySet,
    readRows: (
        sql: string,
        role: ColumnsWithKeysQueryRole,
    ) => Promise<Record<string, unknown>[]>,
): Promise<NetezzaColumnsWithKeysRow[]> {
    if (!queries.keys || !queries.distribution) {
        throw new Error('Netezza columns-with-keys query set is incomplete.');
    }
    const columns = await readRows(queries.columns, 'columns');
    const keys = await readRows(queries.keys, 'keys');
    const distribution = await readRows(queries.distribution, 'distribution');
    return mergeNetezzaColumnsWithKeysRows(columns, keys, distribution);
}
