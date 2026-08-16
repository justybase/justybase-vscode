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
import { JET_PAGE_TYPES } from './JetLayout';
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
    const catalogPages = Array.from({ length: channel.pageCount }, (_, pageNumber) => pageNumber)
        .filter(pageNumber => {
            if (pageNumber < 3) return false;
            const page = channel.pageAt(pageNumber);
            return page[0] === JET_PAGE_TYPES.DATA
                && page.readUInt32LE(4) === 2
                && page.readUInt32LE(4) !== 0x4c41564c;
        });

    const catalogRows: AccessValue[][] = [];
    for (const pageNumber of catalogPages) {
        const page = channel.pageAt(pageNumber);
        const rowCount = page.readUInt16LE(layout.offsetNumRowsOnDataPage);
        for (let rowNumber = 0; rowNumber < rowCount; rowNumber++) {
            const location = catalog.rowLocationAt(pageNumber, rowNumber, page);
            if (location) {
                catalogRows.push(catalog.readRowValues(location));
            }
        }
    }

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
        for (let index = 0; index < oldRows.length; index++) {
            if (!rowsEqual(oldRows[index] ?? [], newRows[index] ?? [])) {
                // A growing row can rewrite every slot on its page.  Resolve
                // the physical location again for each update instead of
                // writing through offsets captured before that rewrite.
                const location = table.rowLocations()[index];
                if (!location) throw new AccessFileError(`Missing physical row ${index} in '${table.name}'.`);
                table.updateRowWithIndexes(location, oldRows[index] ?? [], newRows[index] ?? []);
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
): Promise<void> {
    const buffer = await fs.readFile(stagedPath);
    const layout = jetLayoutFor(format);
    const channel = new JetPageChannel(buffer, layout);

    const afterByName = new Map(afterSnapshots.map(snapshot => [snapshot.definition.name.toLowerCase(), snapshot]));
    const beforeByName = new Map(beforeSnapshots.map(snapshot => [snapshot.definition.name.toLowerCase(), snapshot]));

    for (const table of discoverTables(buffer, format)) {
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
