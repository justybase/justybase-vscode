/**
 * Access (.mdb/.accdb) conversion for File SQL.
 *
 * DuckDB has no built-in Access reader, so tables are converted to CSV by
 * @justybase/access-file (source import, bundled by esbuild — the package is
 * not published to npm) in the connection's temporary directory and read back
 * with DuckDB's read_csv. Conversion is read-only: Access files are never
 * written from File SQL mode.
 *
 * Hidden complex flat tables (attachment/multivalue backing tables, named
 * `f_<GUID>_<field>` by Jackcess convention) are skipped — their values are
 * already serialized into the parent table's complex columns.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AccessFileSession } from '../../../packages/access-file/src';
import { serializeAccessComplexValue } from '../../../packages/access-file/src/complexValues';
import type { AccessValue } from '../../../packages/access-file/src/types';

/** Jackcess naming convention for hidden complex flat tables. */
const COMPLEX_FLAT_TABLE_PATTERN = /^f_[0-9a-f]{32}_/i;

export interface AccessConversionResult {
    tableNames: string[];
    /** CSV path per table, keyed by table name. */
    tableCsvPaths: ReadonlyMap<string, string>;
}

/**
 * Table names of an Access file, excluding system tables and the hidden
 * complex flat tables backing attachment/multivalue columns.
 */
export async function listAccessTableNames(filePath: string): Promise<string[]> {
    const session = await AccessFileSession.open({ filePath, readOnly: true });
    try {
        return session
            .listTableNames(false)
            .filter(name => !COMPLEX_FLAT_TABLE_PATTERN.test(name));
    } finally {
        await session.close();
    }
}

/**
 * Convert every readable table of an Access file to CSV in a source-specific
 * subdirectory of `outDir`. The source directory is stable for the file path,
 * while table filenames are made unique after sanitization. The header row
 * comes from the table's column definitions (Access stores columns separately
 * from data rows); DuckDB's CSV sniffer then infers column names and types.
 */
export async function convertAccessTablesToCsvs(
    filePath: string,
    outDir: string,
): Promise<AccessConversionResult> {
    const session = await AccessFileSession.open({ filePath, readOnly: true });
    const tableNames: string[] = [];
    const tableCsvPaths = new Map<string, string>();
    const sourceDirectory = path.join(outDir, sourceDirectoryName(filePath));
    const usedCsvNames = new Set<string>();
    try {
        fs.mkdirSync(sourceDirectory, { recursive: true });
        for (const tableName of session.listTableNames(false)) {
            if (COMPLEX_FLAT_TABLE_PATTERN.test(tableName)) {
                continue;
            }
            const definition = session.getTableDefinition(tableName);
            const csvName = nextUniqueCsvName(sanitizeTableNameForCsv(tableName), usedCsvNames);
            const csvPath = path.join(sourceDirectory, `${csvName}.csv`);
            await convertTableToCsv(session, tableName, definition.columns.map(column => column.name), csvPath);
            tableNames.push(tableName);
            tableCsvPaths.set(tableName, csvPath);
        }
        if (tableNames.length === 0) {
            throw new Error(`The Access file '${filePath}' does not contain any readable tables.`);
        }
        return { tableNames, tableCsvPaths };
    } finally {
        await session.close();
    }
}

function sourceDirectoryName(filePath: string): string {
    const baseName = sanitizeTableNameForCsv(path.basename(filePath));
    const pathHash = createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 16);
    return `${baseName}_${pathHash}`;
}

function nextUniqueCsvName(baseName: string, usedNames: Set<string>): string {
    let candidate = baseName;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${baseName}_${suffix}`;
        suffix += 1;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
}

function sanitizeTableNameForCsv(tableName: string): string {
    const sanitized = tableName.replace(/[^\w]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return sanitized || 'table';
}

async function convertTableToCsv(
    session: AccessFileSession,
    tableName: string,
    columns: readonly string[],
    csvPath: string,
): Promise<void> {
    const stream = fs.createWriteStream(csvPath);
    try {
        const writeLine = async (line: string): Promise<void> => {
            if (!stream.write(line)) {
                await new Promise<void>(resolve => stream.once('drain', resolve));
            }
        };
        if (columns.length > 0) {
            await writeLine(`${columns.map(csvEscape).join(',')}\n`);
        }
        for await (const row of session.iterateTable(tableName)) {
            await writeLine(`${row.map(csvEscape).join(',')}\n`);
        }
        await new Promise<void>((resolve, reject) => {
            stream.end(() => resolve());
            stream.once('error', reject);
        });
    } catch (error) {
        stream.destroy();
        throw error;
    }
}

function csvEscape(value: AccessValue | undefined): string {
    if (value === undefined || value === null) {
        return '';
    }
    let text: string;
    if (value instanceof Date) {
        text = value.toISOString();
    } else if (typeof value === 'object' && Array.isArray(value)) {
        text = serializeAccessComplexValue(value);
    } else if (typeof value === 'object') {
        text = JSON.stringify(value);
    } else {
        text = String(value);
    }
    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}
