/**
 * Direct-mutation write driver: applies before/after table snapshots to a
 * staged Access file buffer.
 *
 * Replaces the old snapshot-diff writer (accessFileWriter.ts).  Instead of
 * patching rows in fixed slots it uses the Jet write engine
 * (JetTable/JetPageChannel/JetUsageMap/JetLvalWriter) which supports:
 *   - in-place updates with slot padding
 *   - in-page relocation when a row grows beyond its slot
 *   - long-value pages (MEMO/OLE) with LVAL chains
 *   - new data pages when a table runs out of free space
 *   - usage-map maintenance (owned pages + free-space pages)
 */

import * as fs from 'node:fs/promises';
import { AccessFileError } from '../accessFileSession';
import type {
    AccessFileFormat,
    AccessTableSnapshot,
    AccessValue,
} from '../types';
import { jetLayoutFor } from './JetLayout';
import { JetPageChannel } from './JetPageChannel';
import { JetTable } from './JetTable';

interface DiscoveredTable {
    readonly name: string;
    readonly definitionPage: number;
    readonly generatedComplex: boolean;
}

function discoverTables(buffer: Buffer, format: AccessFileFormat): DiscoveredTable[] {
    const layout = jetLayoutFor(format);
    const channel = new JetPageChannel(buffer, layout);

    const catalog = new JetTable(channel, 'MSysObjects', 2);
    // Use the catalog's owned-pages map instead of scanning every data page.
    // Long-value pages can carry the same table-definition number as the
    // catalog and must never be interpreted as MSysObjects rows.
    const catalogRows = catalog.rowLocations().map(location => catalog.readRowValues(location));

    const nameIndex = catalog.columns.findIndex(column => /^name$/i.test(column.name));
    const idIndex = catalog.columns.findIndex(column => /^id$/i.test(column.name));
    const typeIndex = catalog.columns.findIndex(column => /^type$/i.test(column.name));
    const flagsIndex = catalog.columns.findIndex(column => /^flags$/i.test(column.name));
    if (nameIndex < 0 || idIndex < 0 || typeIndex < 0) {
        throw new AccessFileError('MSysObjects does not contain the expected catalog columns.');
    }

    return catalogRows
        .filter(row => Number(row[typeIndex]) === 1
            // The high system flag is also used for Access's generated flat
            // tables behind complex columns.  Those tables are writable SQL
            // targets, so only the alternate-system flag is excluded here;
            // MSys* catalogs are still skipped by the caller below.
            && !((Number(row[flagsIndex]) || 0) & 0x02))
        .map(row => {
            const flags = Number(row[flagsIndex]) || 0;
            return {
                name: String(row[nameIndex]),
                definitionPage: Number(row[idIndex]) & 0x00ffffff,
                generatedComplex: flags < 0 && (flags & 0x02) === 0,
            };
        })
        .filter(table => table.definitionPage > 0 && table.name.length > 0);
}

function rowsEqual(left: readonly AccessValue[], right: readonly AccessValue[]): boolean {
    return left.length === right.length && left.every((value, index) => valuesEqual(value, right[index] ?? null));
}

function valuesEqual(left: AccessValue, right: AccessValue): boolean {
    if (left instanceof Uint8Array && right instanceof Uint8Array) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    if (left instanceof Date && right instanceof Date) {
        return left.getTime() === right.getTime();
    }
    return left === right;
}

function stableValueKey(value: AccessValue): string | undefined {
    if (value === null || Array.isArray(value)) {
        return undefined;
    }
    if (value instanceof Date) {
        return `date:${value.getTime()}`;
    }
    if (value instanceof Uint8Array) {
        return `bytes:${Buffer.from(value).toString('hex')}`;
    }
    return `${typeof value}:${String(value)}`;
}

function rowKey(
    row: readonly AccessValue[],
    columns: readonly number[],
): string | undefined {
    const values = columns.map(column => stableValueKey(row[column] ?? null));
    return values.every((value): value is string => value !== undefined)
        ? JSON.stringify(values)
        : undefined;
}

function stableRowKeyColumns(table: JetTable, before: AccessTableSnapshot): number[] {
    const uniqueIndex = table.indexDatas.find(index => index.backingPrimaryKey || index.isUnique);
    if (uniqueIndex && uniqueIndex.columns.length > 0) {
        return uniqueIndex.columns.map(column => column.columnNumber);
    }

    const primaryKey = before.definition.columns
        .map((column, index) => column.isPrimaryKey ? index : -1)
        .filter(index => index >= 0);
    if (primaryKey.length > 0) {
        return primaryKey;
    }

    const autoNumber = before.definition.columns.findIndex(column => column.autoLong || column.autoUuid);
    if (autoNumber >= 0) {
        return [autoNumber];
    }
    const physicalAutoNumber = table.columns.findIndex(column => column.autoLong || column.autoUuid);
    return physicalAutoNumber >= 0 ? [physicalAutoNumber] : [];
}

/**
 * Aligns an UPDATE result with physical rows when the mirror changes the
 * result order.  Access tables with a unique index or AutoNumber have a
 * stable key; tables without one retain the existing positional behavior,
 * because their rows have no identity available in a snapshot.
 */
function alignUpdatedRows(
    table: JetTable,
    before: AccessTableSnapshot,
    after: AccessTableSnapshot,
): readonly (readonly AccessValue[])[] {
    const keyColumns = stableRowKeyColumns(table, before);
    if (keyColumns.length === 0) {
        return after.rows;
    }

    const beforeKeys = before.rows.map(row => rowKey(row, keyColumns));
    const afterKeys = after.rows.map(row => rowKey(row, keyColumns));
    if (beforeKeys.some(key => key === undefined) || afterKeys.some(key => key === undefined)) {
        return after.rows;
    }

    const afterByKey = new Map<string, readonly AccessValue[]>();
    for (let index = 0; index < after.rows.length; index++) {
        const key = afterKeys[index]!;
        if (afterByKey.has(key)) {
            return after.rows;
        }
        afterByKey.set(key, after.rows[index]!);
    }

    const aligned: (readonly AccessValue[])[] = [];
    for (const key of beforeKeys) {
        const row = afterByKey.get(key!);
        if (!row) {
            // A changed key is a valid UPDATE.  Without a stable match, keep
            // the mirror's physical order rather than guessing a mapping.
            return after.rows;
        }
        aligned.push(row);
    }
    return aligned;
}

function snapshotsEqual(left: AccessTableSnapshot, right: AccessTableSnapshot): boolean {
    return left.rows.length === right.rows.length
        && left.rows.every((row, index) => rowsEqual(row, right.rows[index] ?? []));
}

/** LCS-style mapping of rows removed from the middle of a result set. */
function findRemovedRows(
    before: readonly (readonly AccessValue[])[],
    after: readonly (readonly AccessValue[])[],
): number[] {
    const removed: number[] = [];
    let afterIndex = 0;
    for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex++) {
        if (afterIndex < after.length && rowsEqual(before[beforeIndex] ?? [], after[afterIndex] ?? [])) {
            afterIndex++;
        } else {
            removed.push(beforeIndex);
        }
    }
    if (afterIndex !== after.length) {
        throw new AccessFileError('Access writer cannot map a reordered result set back to physical rows.');
    }
    return removed;
}

function applyTableChange(
    table: JetTable,
    before: AccessTableSnapshot,
    after: AccessTableSnapshot,
): void {
    const oldRows = before.rows;
    const newRows = after.rows;
    const locations = table.rowLocations();

    if (locations.length !== oldRows.length) {
        throw new AccessFileError(
            `Access table '${table.name}' physical row count (${locations.length}) does not match the snapshot (${oldRows.length}).`,
        );
    }

    if (newRows.length === oldRows.length) {
        const alignedRows = alignUpdatedRows(table, before, after);
        for (let index = 0; index < oldRows.length; index++) {
            if (!rowsEqual(oldRows[index] ?? [], alignedRows[index] ?? [])) {
                // A growing row can rewrite every slot on its page.  Resolve
                // the physical location again for each update instead of
                // writing through offsets captured before that rewrite.
                const location = table.rowLocations()[index];
                if (!location) throw new AccessFileError(`Missing physical row ${index} in '${table.name}'.`);
                table.updateRowWithIndexes(location, oldRows[index] ?? [], alignedRows[index] ?? []);
            }
        }
        return;
    }

    if (newRows.length < oldRows.length) {
        // Delete from the end so removing a row does not change the snapshot
        // index of any row that is still waiting to be processed.
        const removed = findRemovedRows(oldRows, newRows).sort((left, right) => right - left);
        for (const index of removed) {
            const location = table.rowLocations()[index];
            if (!location) throw new AccessFileError(`Missing physical row ${index} in '${table.name}'.`);
            table.deleteRowWithIndexes(location, oldRows[index] ?? []);
        }
        return;
    }

    if (oldRows.every((row, index) => rowsEqual(row, newRows[index] ?? []))) {
        for (const row of newRows.slice(oldRows.length)) {
            table.addRowWithIndexes(row);
        }
        return;
    }
    throw new AccessFileError(`Access writer cannot combine updates and inserts for '${table.name}' in one batch.`);
}

/**
 * Applies the snapshot changes to the staged copy of an Access file.
 * The staged copy is read, mutated in place and written back; the caller
 * (AccessFileSession.writeAtomically) installs it atomically.
 */
export async function writeAccessSnapshotChanges(
    stagedPath: string,
    format: AccessFileFormat,
    beforeSnapshots: readonly AccessTableSnapshot[],
    afterSnapshots: readonly AccessTableSnapshot[],
    targetTableName?: string,
): Promise<void> {
    const buffer = await fs.readFile(stagedPath);
    const layout = jetLayoutFor(format);
    const channel = new JetPageChannel(buffer, layout);

    const afterByName = new Map(afterSnapshots.map(snapshot => [snapshot.definition.name.toLowerCase(), snapshot]));
    const beforeByName = new Map(beforeSnapshots.map(snapshot => [snapshot.definition.name.toLowerCase(), snapshot]));

    const discoveredTables = discoverTables(buffer, format);
    const tablesToWrite = targetTableName
        ? discoveredTables.filter(table => table.name.localeCompare(targetTableName, undefined, { sensitivity: 'accent' }) === 0)
        : discoveredTables;
    if (targetTableName && tablesToWrite.length === 0) {
        throw new AccessFileError(`Access table '${targetTableName}' cannot be found in the staged file.`);
    }

    for (const table of tablesToWrite) {
        if (/^MSys/i.test(table.name)) {
            continue;
        }
        const before = beforeByName.get(table.name.toLowerCase());
        const after = afterByName.get(table.name.toLowerCase());
        if (!before || !after) {
            if (table.generatedComplex) continue;
            throw new AccessFileError(`Creating or dropping Access tables is not enabled for '${table.name}'.`);
        }
        if (snapshotsEqual(before, after)) {
            continue;
        }
        const jetTable = new JetTable(channel, table.name, table.definitionPage);
        applyTableChange(jetTable, before, after);
        jetTable.writeDefinitionCounters();
    }

    await fs.writeFile(stagedPath, channel.buffer);
}
