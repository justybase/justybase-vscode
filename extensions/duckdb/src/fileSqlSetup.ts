/**
 * Pure SQL setup builder for the 'file' dialect (Excel/CSV/Parquet/Avro via
 * DuckDB). Generates the statements that register file-backed views so the
 * file behaves like a table (schema explorer, completion, SELECT).
 */

import * as path from 'path';

export type FileDataFormat = 'csv' | 'tsv' | 'parquet' | 'avro' | 'xlsx';

export const FILE_WORKSPACE_OPTION = 'fileWorkspace';
export const FILE_WORKSPACE_VERSION = 1;

export interface FileWorkspaceConfig {
    version: typeof FILE_WORKSPACE_VERSION;
    files: string[];
}

export const FILE_DIALECT_EXTENSIONS: Readonly<Record<string, FileDataFormat>> = {
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.parquet': 'parquet',
    '.avro': 'avro',
    '.xlsx': 'xlsx',
};

export function detectFileDataFormat(filePath: string): FileDataFormat | undefined {
    return FILE_DIALECT_EXTENSIONS[path.extname(filePath).toLowerCase()];
}

/** Normalize a local source path for stable DuckDB view names and persistence. */
export function normalizeFilePath(filePath: string): string {
    const trimmed = filePath.trim();
    return trimmed.length > 0 ? path.resolve(trimmed).split(path.sep).join('/') : '';
}

export function serializeFileWorkspace(files: readonly string[]): string {
    const normalizedFiles = Array.from(
        new Set(files.map(normalizeFilePath).filter(filePath => filePath.length > 0)),
    );
    return JSON.stringify({ version: FILE_WORKSPACE_VERSION, files: normalizedFiles } satisfies FileWorkspaceConfig);
}

/** Return workspace paths, or undefined when the option is not a workspace. */
export function parseFileWorkspace(value: unknown): string[] | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(value) as Partial<FileWorkspaceConfig>;
        if (parsed.version !== FILE_WORKSPACE_VERSION || !Array.isArray(parsed.files)) {
            return undefined;
        }
        const files = parsed.files.filter((filePath): filePath is string => typeof filePath === 'string');
        return Array.from(new Set(files.map(normalizeFilePath).filter(filePath => filePath.length > 0)));
    } catch {
        return undefined;
    }
}

export function getFileWorkspacePaths(options?: Record<string, string | number | boolean>): string[] | undefined {
    return parseFileWorkspace(options?.[FILE_WORKSPACE_OPTION]);
}

export function sanitizeViewName(filePath: string): string {
    const base = path.basename(filePath).replace(/\.[^.]+$/, '');
    const sanitized = base.replace(/[^\w]/g, '_').replace(/_+/g, '_');
    return sanitized || 'file';
}

function quoteIdentifier(name: string): string {
    // Always quote: preserves case of the file-derived view name.
    return `"${name.replace(/"/g, '""')}"`;
}

export function quoteFileViewIdentifier(name: string): string {
    return quoteIdentifier(normalizeFilePath(name));
}

export function fileSheetViewName(filePath: string, sheetName: string): string {
    return `${normalizeFilePath(filePath)}#sheet=${sheetName}`;
}

function nextUniqueSheetViewName(
    viewName: string,
    sheetName: string,
    usedNames: Set<string>,
): string {
    const baseName = `${viewName}__${sanitizeViewName(sheetName)}`;
    let candidate = baseName;
    let suffix = 2;
    const key = (name: string) => name.toLowerCase();

    while (usedNames.has(key(candidate)) || key(candidate) === key(viewName)) {
        candidate = `${baseName}_${suffix}`;
        suffix += 1;
    }

    usedNames.add(key(candidate));
    return candidate;
}

/** Name of the materialized editable table for a file. */
export function editableTableName(filePath: string): string {
    return `${sanitizeViewName(filePath)}_edit`;
}

/**
 * Materialize the first-sheet/main view as a real table so INSERT/UPDATE/
 * DELETE work (DuckDB views are read-only).
 */
export function buildEditableTableSql(filePath: string): string {
    const viewName = sanitizeViewName(filePath);
    const tableName = editableTableName(filePath);
    return `CREATE OR REPLACE TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM ${quoteIdentifier(viewName)}`;
}

export interface SaveEditsSqlResult {
    sql: string;
    /** True when the write targets a new file next to the original. */
    writesToNewFile: boolean;
    targetPath: string;
}

/**
 * SQL that writes the editable table back to disk. DuckDB's 'excel'
 * extension supports FORMAT XLSX, so xlsx files can be overwritten too.
 */
export function buildSaveEditsSql(filePath: string, format: FileDataFormat): SaveEditsSqlResult {
    const tableName = editableTableName(filePath);
    const normalizedPath = filePath.split(path.sep).join('/');
    const source = `(SELECT * FROM ${quoteIdentifier(tableName)})`;

    switch (format) {
        case 'csv':
            return {
                sql: `COPY ${source} TO ${quoteLiteral(normalizedPath)} (FORMAT CSV, HEADER)`,
                writesToNewFile: false,
                targetPath: filePath,
            };
        case 'tsv':
            return {
                sql: `COPY ${source} TO ${quoteLiteral(normalizedPath)} (FORMAT CSV, HEADER, DELIMITER ${quoteLiteral('\t')})`,
                writesToNewFile: false,
                targetPath: filePath,
            };
        case 'parquet':
            return {
                sql: `COPY ${source} TO ${quoteLiteral(normalizedPath)} (FORMAT PARQUET)`,
                writesToNewFile: false,
                targetPath: filePath,
            };
        case 'xlsx':
            return {
                sql: `COPY ${source} TO ${quoteLiteral(normalizedPath)} (FORMAT XLSX)`,
                writesToNewFile: false,
                targetPath: filePath,
            };
        case 'avro':
            {
                const targetPath = filePath.replace(/\.avro$/i, '_edited.parquet');
                const normalizedTargetPath = targetPath.split(path.sep).join('/');
                return {
                    sql: `COPY ${source} TO ${quoteLiteral(normalizedTargetPath)} (FORMAT PARQUET)`,
                    writesToNewFile: true,
                    targetPath,
                };
            }
    }
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Extensions that must be installed/loaded before read_* works.
 * CSV/TSV/Parquet are core; XLSX uses the DuckDB 'excel' extension and AVRO
 * the 'avro' extension — both downloaded once from the internet on first use.
 */
export function requiredDuckDbExtensions(format: FileDataFormat): string[] {
    switch (format) {
        case 'xlsx':
            return ['excel'];
        case 'avro':
            return ['avro'];
        default:
            return [];
    }
}

function readFunctionSql(format: FileDataFormat, filePath: string): string {
    const normalizedPath = filePath.split(path.sep).join('/');
    switch (format) {
        case 'csv':
            return `read_csv(${quoteLiteral(normalizedPath)})`;
        case 'tsv':
            return `read_csv(${quoteLiteral(normalizedPath)}, delim=${quoteLiteral('\t')})`;
        case 'parquet':
            return `read_parquet(${quoteLiteral(normalizedPath)})`;
        case 'avro':
            return `read_avro(${quoteLiteral(normalizedPath)})`;
        case 'xlsx':
            return `read_xlsx(${quoteLiteral(normalizedPath)})`;
    }
}

export interface FileViewSetupResult {
    statements: string[];
    viewName: string;
    /** Per-sheet view names created for xlsx files. */
    sheetViewNames: string[];
    usesPerSheetViews: boolean;
}

export interface FileWorkspaceViewSource {
    filePath: string;
    format: FileDataFormat;
    discoveredSheets?: string[];
}

export interface FileWorkspaceViewSetupResult {
    statements: string[];
    viewNames: string[];
    sheetViewNames: string[];
}

/**
 * Build read-only views for a multi-file workspace. View names are the
 * normalized absolute paths so different files with the same basename never
 * collide and no workspace alias is required in SQL.
 */
export function buildFileWorkspaceViewSetupSql(
    sources: readonly FileWorkspaceViewSource[],
): FileWorkspaceViewSetupResult {
    const statements: string[] = [];
    const viewNames: string[] = [];
    const sheetViewNames: string[] = [];

    for (const source of sources) {
        const filePath = normalizeFilePath(source.filePath);
        const viewName = filePath;
        viewNames.push(viewName);

        if (source.format === 'xlsx') {
            const sheets = (source.discoveredSheets ?? []).filter(sheet => sheet.trim().length > 0);
            for (const sheet of sheets) {
                const sheetViewName = fileSheetViewName(filePath, sheet);
                statements.push(
                    `CREATE OR REPLACE VIEW ${quoteIdentifier(sheetViewName)} AS SELECT * FROM read_xlsx(${quoteLiteral(filePath)}, sheet=${quoteLiteral(sheet)})`,
                );
                sheetViewNames.push(sheetViewName);
            }
            statements.push(
                `CREATE OR REPLACE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM read_xlsx(${quoteLiteral(filePath)})`,
            );
        } else {
            statements.push(
                `CREATE OR REPLACE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM ${readFunctionSql(source.format, filePath)}`,
            );
        }
    }

    return { statements, viewNames, sheetViewNames };
}

/**
 * Build the setup statements for a single data file.
 *
 * - CSV/TSV/Parquet/Avro: one view named after the file.
 * - XLSX: when `sheet` is provided, one view for that sheet; otherwise one
 *   view per discovered sheet (`<name>__<sheet>`) plus a `<name>` view that
 *   reads the first sheet (the DuckDB 'excel' extension has no
 *   read_xlsx_all, so `<name>` always works).
 */
export function buildFileViewSetupSql(
    filePath: string,
    format: FileDataFormat,
    options: { sheet?: string; discoveredSheets?: string[] } = {},
): FileViewSetupResult {
    const viewName = sanitizeViewName(filePath);
    const statements: string[] = [];
    const sheetViewNames: string[] = [];
    const normalizedPath = filePath.split(path.sep).join('/');

    if (format === 'xlsx') {
        const sheet = options.sheet?.trim();
        if (sheet) {
            const sheetSql = `read_xlsx(${quoteLiteral(normalizedPath)}, sheet=${quoteLiteral(sheet)})`;
            statements.push(`CREATE OR REPLACE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM ${sheetSql}`);
        } else {
            const sheets = (options.discoveredSheets ?? []).filter(item => item.trim().length > 0);
            const usedSheetViewNames = new Set<string>();
            for (const discoveredSheet of sheets) {
                const sheetViewName = nextUniqueSheetViewName(viewName, discoveredSheet, usedSheetViewNames);
                const sheetSql = `read_xlsx(${quoteLiteral(normalizedPath)}, sheet=${quoteLiteral(discoveredSheet)})`;
                statements.push(`CREATE OR REPLACE VIEW ${quoteIdentifier(sheetViewName)} AS SELECT * FROM ${sheetSql}`);
                sheetViewNames.push(sheetViewName);
            }
            // First-sheet view: always available, even without sheet discovery.
            statements.push(`CREATE OR REPLACE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM read_xlsx(${quoteLiteral(normalizedPath)})`);
        }
    } else {
        statements.push(`CREATE OR REPLACE VIEW ${quoteIdentifier(viewName)} AS SELECT * FROM ${readFunctionSql(format, filePath)}`);
    }

    return {
        statements,
        viewName,
        sheetViewNames,
        usesPerSheetViews: format === 'xlsx' && !options.sheet?.trim() && sheetViewNames.length > 0,
    };
}
