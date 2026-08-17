/**
 * XLSB support for File SQL (DuckDB): sheet discovery and XLSB -> CSV
 * conversion through @justybase/spreadsheet-tasks (XlsbReader). DuckDB has
 * no read_xlsb function, so each .xlsb workbook is converted to CSV files
 * (one per sheet) in a per-connection temporary directory and read back with
 * DuckDB's built-in read_csv (the CSV sniffer infers the header and column
 * types, mirroring read_xlsx semantics).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';

interface XlsbReaderLike {
    open(filePath: string): Promise<void>;
    getSheetNames(): string[];
    read(): Promise<boolean>;
    getValue(index: number): unknown;
    fieldCount: number;
    close?(): Promise<void>;
}

interface SpreadsheetTasksModule {
    ReaderFactory: {
        create(filePath: string): XlsbReaderLike;
    };
}

const _extensionRequire = createRequire(__filename);
let _spreadsheetTasksModulePromise: Promise<SpreadsheetTasksModule> | undefined;

function loadSpreadsheetTasks(): Promise<SpreadsheetTasksModule> {
    _spreadsheetTasksModulePromise ??= Promise.resolve().then(() => {
        const mod = _extensionRequire('@justybase/spreadsheet-tasks') as SpreadsheetTasksModule;
        if (!mod || typeof mod.ReaderFactory?.create !== 'function') {
            throw new Error('@justybase/spreadsheet-tasks is not available (XLSB support requires it).');
        }
        return mod;
    });
    return _spreadsheetTasksModulePromise;
}

/** Sheet names in workbook order. Returns [] when the workbook cannot be read. */
export async function listXlsbSheetNames(filePath: string): Promise<string[]> {
    const { ReaderFactory } = await loadSpreadsheetTasks();
    const reader = ReaderFactory.create(filePath);
    try {
        await reader.open(filePath);
        return reader.getSheetNames();
    } finally {
        if (typeof reader.close === 'function') {
            try {
                await reader.close();
            } catch {
                // Ignore cleanup failures while surfacing the discovery result.
            }
        }
    }
}

export interface XlsbConversionResult {
    /** All discovered sheet names in workbook order. */
    sheetNames: string[];
    /** CSV path for the view named after the file (first target sheet). */
    firstCsvPath: string;
    /** Per-sheet CSV paths keyed by sheet name. */
    sheetCsvPaths: ReadonlyMap<string, string>;
}

/**
 * Convert an XLSB workbook to CSV files inside `outDir`.
 *
 * When `options.sheet` is provided, only that sheet is converted and becomes
 * `firstCsvPath` (matching the xlsx `sheet` option semantics). Otherwise every
 * discovered sheet is converted: the first sheet as `<base>.csv` and the rest
 * as `<base>__<sanitized-sheet>.csv`. All rows are written verbatim (no
 * synthetic header) so DuckDB's CSV sniffer performs header/type detection
 * exactly like `read_xlsx` does.
 */
export async function convertXlsbToCsvs(
    filePath: string,
    outDir: string,
    options: { sheet?: string } = {},
): Promise<XlsbConversionResult> {
    const { ReaderFactory } = await loadSpreadsheetTasks();
    const reader = ReaderFactory.create(filePath);
    const baseName = path.basename(filePath).replace(/\.[^.]+$/, '');
    const sheetCsvPaths = new Map<string, string>();

    try {
        await reader.open(filePath);
        const sheetNames = reader.getSheetNames();
        if (sheetNames.length === 0) {
            throw new Error(`XLSB file '${filePath}' contains no sheets.`);
        }

        const selected = options.sheet?.trim();
        if (selected) {
            const sheetIndex = sheetNames.indexOf(selected);
            if (sheetIndex === -1) {
                throw new Error(
                    `Sheet '${selected}' was not found in '${filePath}'. Available sheets: ${sheetNames.join(', ')}.`,
                );
            }
            let firstCsvPath = '';
            const csvPath = path.join(outDir, `${baseName}.csv`);
            await convertSheetToCsv(reader, sheetIndex, csvPath);
            sheetCsvPaths.set(sheetNames[sheetIndex], csvPath);
            firstCsvPath = csvPath;
            return { sheetNames, firstCsvPath, sheetCsvPaths };
        }

        let firstCsvPath = '';
        const usedCsvNames = new Set<string>();
        for (let index = 0; index < sheetNames.length; index += 1) {
            const sheetName = sheetNames[index];
            let csvName = index === 0
                ? `${baseName}.csv`
                : `${baseName}__${sanitizeSheetNameForCsv(sheetName)}.csv`;
            let collisionSuffix = 2;
            while (usedCsvNames.has(csvName)) {
                csvName = index === 0
                    ? `${baseName}_${collisionSuffix}.csv`
                    : `${baseName}__${sanitizeSheetNameForCsv(sheetName)}_${collisionSuffix}.csv`;
                collisionSuffix += 1;
            }
            usedCsvNames.add(csvName);
            const csvPath = path.join(outDir, csvName);
            await convertSheetToCsv(reader, index, csvPath);
            sheetCsvPaths.set(sheetName, csvPath);
            if (index === 0) {
                firstCsvPath = csvPath;
            }
        }
        return { sheetNames, firstCsvPath, sheetCsvPaths };
    } finally {
        if (typeof reader.close === 'function') {
            try {
                await reader.close();
            } catch {
                // Ignore cleanup failures while surfacing the conversion result.
            }
        }
    }
}

function sanitizeSheetNameForCsv(sheetName: string): string {
    const sanitized = sheetName.replace(/[^\w]/g, '_').replace(/_+/g, '_');
    return sanitized || 'Sheet';
}

async function convertSheetToCsv(reader: XlsbReaderLike, sheetIndex: number, csvPath: string): Promise<void> {
    // The first sheet is active after open(); later sheets are initialized
    // lazily through XlsbReader._initSheet (internal to @justybase/spreadsheet-tasks
    // 2.1.0 — pinned in package.json). Fail loudly instead of silently writing
    // the previous sheet's rows when a future version drops the method.
    if (sheetIndex > 0) {
        const initializable = reader as XlsbReaderLike & { _initSheet?(index: number): Promise<boolean> };
        if (typeof initializable._initSheet !== 'function') {
            throw new Error(
                'Installed @justybase/spreadsheet-tasks does not support multi-sheet XLSB reading; ' +
                'update the DuckDB + Files extension.',
            );
        }
        const initialized = await initializable._initSheet(sheetIndex);
        if (!initialized) {
            throw new Error(`XLSB sheet ${sheetIndex} could not be read from the workbook.`);
        }
    }

    const stream = fs.createWriteStream(csvPath, { encoding: 'utf8' });
    try {
        while (await reader.read()) {
            const row: unknown[] = [];
            for (let index = 0; index < reader.fieldCount; index += 1) {
                row.push(reader.getValue(index));
            }
            if (!stream.write(`${row.map(csvEscape).join(',')}\n`)) {
                await new Promise<void>(resolve => stream.once('drain', resolve));
            }
        }
    } finally {
        await new Promise<void>((resolve, reject) => {
            stream.end();
            stream.on('finish', resolve);
            stream.on('error', reject);
        });
    }
}

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    let text: string;
    if (value instanceof Date) {
        text = value.toISOString();
    } else if (typeof value === 'boolean') {
        text = value ? 'true' : 'false';
    } else {
        text = String(value);
    }
    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}
