/**
 * Shared logic for managing "file" connection profiles (xlsx/xlsb/mdb/accdb/csv/tsv/parquet/avro).
 * Used by the File Connection Manager webview panel and by the schema tree
 * drag & drop handler. The workspace serialization format must stay compatible
 * with extensions/duckdb/src/fileSqlSetup.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionDetails } from '../types';
import type { ConnectionManager } from '../core/connectionManager';

export type FileDataFormat = 'csv' | 'tsv' | 'parquet' | 'avro' | 'xlsx' | 'xlsb' | 'access';

export const FILE_WORKSPACE_OPTION = 'fileWorkspace';
export const FILE_WORKSPACE_VERSION = 1;

export const FILE_DIALECT_EXTENSIONS: Readonly<Record<string, FileDataFormat>> = {
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.parquet': 'parquet',
    '.avro': 'avro',
    '.xlsx': 'xlsx',
    '.xlsb': 'xlsb',
    '.mdb': 'access',
    '.accdb': 'access',
};

export interface FileWorkspaceConfig {
    version: typeof FILE_WORKSPACE_VERSION;
    files: string[];
}

export interface FileConnectionExport {
    format: 'justybase.file-connections';
    version: 1;
    connections: FileConnectionExportEntry[];
}

export interface FileConnectionExportEntry {
    name: string;
    files: string[];
    editable?: boolean;
    sheet?: string;
}

export interface FileConnectionImportResult {
    created: string[];
    skipped: string[];
    warnings: string[];
}

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

/** Absolute file paths managed by a file connection profile (workspace first, else single-file). */
export function getFilePaths(details: ConnectionDetails): string[] {
    const workspacePaths = parseFileWorkspace(details.options?.[FILE_WORKSPACE_OPTION]);
    if (workspacePaths && workspacePaths.length > 0) {
        return workspacePaths;
    }
    const singleFile = details.database?.trim();
    return singleFile ? [normalizeFilePath(singleFile)] : [];
}

/** True when the connection uses the multi-file (read-only) workspace representation. */
export function isFileWorkspaceProfile(details: ConnectionDetails | undefined): boolean {
    const paths = parseFileWorkspace(details?.options?.[FILE_WORKSPACE_OPTION]);
    return Boolean(paths && paths.length > 1);
}

export interface FileConnectionFileInfo {
    path: string;
    name: string;
    format: FileDataFormat | undefined;
    sizeBytes?: number;
    exists: boolean;
}

export function toFileInfo(filePath: string): FileConnectionFileInfo {
    const normalized = normalizeFilePath(filePath);
    let sizeBytes: number | undefined;
    let exists = false;
    try {
        const stat = fs.statSync(normalized);
        if (stat.isFile()) {
            exists = true;
            sizeBytes = stat.size;
        }
    } catch {
        exists = false;
    }
    return {
        path: normalized,
        name: path.basename(normalized),
        format: detectFileDataFormat(normalized),
        sizeBytes,
        exists,
    };
}

/**
 * Build updated connection details for a new file list.
 * Single file  -> single-file profile (editable copy allowed except Access).
 * Multiple     -> read-only workspace (editable forced off, `sheet` dropped).
 */
export function buildFileConnectionDetails(
    name: string,
    filePaths: readonly string[],
    current: ConnectionDetails | undefined,
): { details: ConnectionDetails; modeChanged: boolean; editableCleared: boolean } {
    const normalizedFiles = Array.from(
        new Set(filePaths.map(normalizeFilePath).filter(filePath => filePath.length > 0)),
    );
    const options: Record<string, string | number | boolean> = { ...(current?.options ?? {}) };
    const base: ConnectionDetails = {
        name,
        host: 'local',
        database: normalizedFiles[0] ?? '',
        user: 'file',
        dbType: 'file',
        options,
    };
    if (current?.accentColor) {
        base.accentColor = current.accentColor;
    }

    const wasEditable = current?.options?.editable === true;
    const wasWorkspace = isFileWorkspaceProfile(current);
    let editableCleared = false;

    if (normalizedFiles.length <= 1) {
        delete options[FILE_WORKSPACE_OPTION];
        if (normalizedFiles.length === 1) {
            if (detectFileDataFormat(normalizedFiles[0]) === 'access') {
                if (wasEditable) {
                    editableCleared = true;
                }
                delete options.editable;
                delete options.sheet;
            } else {
                options.editable = wasEditable;
            }
        } else {
            delete options.editable;
            delete options.sheet;
        }
    } else {
        options[FILE_WORKSPACE_OPTION] = serializeFileWorkspace(normalizedFiles);
        if (wasEditable) {
            editableCleared = true;
        }
        delete options.editable;
        delete options.sheet;
    }

    const isWorkspace = normalizedFiles.length > 1;
    return { details: base, modeChanged: wasWorkspace !== isWorkspace, editableCleared };
}

/**
 * Persist an updated file list on an existing file connection profile.
 * Returns the newly built details (or undefined when the profile is gone).
 */
export async function applyFilePathsToConnection(
    connectionManager: ConnectionManager,
    connectionName: string,
    filePaths: readonly string[],
): Promise<ConnectionDetails | undefined> {
    const current = await connectionManager.getConnection(connectionName);
    if (!current) {
        return undefined;
    }
    const { details } = buildFileConnectionDetails(connectionName, filePaths, current);
    await saveFileConnectionDetails(connectionManager, details);
    return details;
}

/** Persist a changed File SQL profile and invalidate sessions using its old file list. */
export async function saveFileConnectionDetails(
    connectionManager: ConnectionManager,
    details: ConnectionDetails,
): Promise<void> {
    if (!details.name) {
        throw new Error('File SQL connection name is required.');
    }
    await connectionManager.saveConnection(details);
    await connectionManager.refreshFileConnection(details.name);
}

/** Worksheet names of an xlsx/xlsb workbook (empty for other formats). */
export async function listXlsxSheetNames(filePath: string): Promise<string[]> {
    const normalized = normalizeFilePath(filePath);
    const format = detectFileDataFormat(normalized);
    if (format !== 'xlsx') {
        return [];
    }
    const { ReaderFactory } = require('@justybase/spreadsheet-tasks') as unknown as {
        ReaderFactory: { create(filePath: string): { open(filePath: string): Promise<void>; getSheetNames(): string[]; close(): Promise<void> } };
    };
    const reader = ReaderFactory.create(normalized);
    try {
        await reader.open(normalized);
        return typeof reader.getSheetNames === 'function' ? reader.getSheetNames() : [];
    } finally {
        try {
            await reader.close();
        } catch {
            // Best-effort close.
        }
    }
}

/** Human readable label for a file format badge. */
export function fileFormatLabel(format: FileDataFormat | undefined): string {
    switch (format) {
        case 'xlsx': return 'Excel';
        case 'xlsb': return 'Excel (XLSB)';
        case 'csv': return 'CSV';
        case 'tsv': return 'TSV';
        case 'parquet': return 'Parquet';
        case 'avro': return 'Avro';
        case 'access': return 'Access';
        default: return 'File';
    }
}

export function formatFileSize(sizeBytes: number | undefined): string {
    if (sizeBytes === undefined) {
        return '';
    }
    if (sizeBytes < 1024) {
        return `${sizeBytes} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = sizeBytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

export function serializeFileConnectionExport(
    name: string,
    details: ConnectionDetails,
): FileConnectionExportEntry {
    return {
        name,
        files: getFilePaths(details),
        editable: details.options?.editable === true ? true : undefined,
        sheet: typeof details.options?.sheet === 'string' ? details.options.sheet : undefined,
    };
}

export function serializeFileConnectionsExport(entries: FileConnectionExportEntry[]): string {
    const exportData: FileConnectionExport = {
        format: 'justybase.file-connections',
        version: 1,
        connections: entries,
    };
    return JSON.stringify(exportData, null, 2);
}

/**
 * Validate and parse an exported file-connections JSON payload.
 * Throws with a user-facing message when the payload is not recognized.
 */
export function parseFileConnectionsExport(json: string): FileConnectionExportEntry[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error('The selected file is not valid JSON.');
    }
    const data = parsed as Partial<FileConnectionExport>;
    if (!data || data.format !== 'justybase.file-connections') {
        throw new Error('The selected file is not a JustyBase File Connections export.');
    }
    if (data.version !== 1) {
        throw new Error(`Unsupported File Connections export version: ${String(data.version)}.`);
    }
    if (!Array.isArray(data.connections)) {
        throw new Error('The export does not contain any connections.');
    }
    return data.connections
        .filter((entry): entry is FileConnectionExportEntry => Boolean(entry && typeof entry === 'object'))
        .map(entry => ({
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `File SQL ${entry.files?.length ?? 0} file(s)`,
            files: Array.isArray(entry.files)
                ? Array.from(new Set(entry.files.map(normalizeFilePath).filter(filePath => filePath.length > 0)))
                : [],
            editable: entry.editable === true,
            sheet: typeof entry.sheet === 'string' ? entry.sheet : undefined,
        }));
}

/** Create file connection profiles from an export payload. Returns created names, skipped and warnings. */
export async function importFileConnections(
    connectionManager: ConnectionManager,
    entries: FileConnectionExportEntry[],
): Promise<FileConnectionImportResult> {
    const existingNames = new Set((await connectionManager.getConnections()).map(connection => connection.name));
    const created: string[] = [];
    const skipped: string[] = [];
    const warnings: string[] = [];

    for (const entry of entries) {
        if (entry.files.length === 0) {
            skipped.push(entry.name);
            warnings.push(`'${entry.name}' was skipped because it does not contain any data files.`);
            continue;
        }

        let name = entry.name;
        let suffix = 2;
        const baseName = name;
        while (existingNames.has(name)) {
            name = `${baseName} (${suffix})`;
            suffix += 1;
        }
        existingNames.add(name);

        const details: ConnectionDetails = {
            name,
            host: 'local',
            database: entry.files[0],
            user: 'file',
            dbType: 'file',
            options: {},
        };
        if (entry.files.length > 1) {
            details.options![FILE_WORKSPACE_OPTION] = serializeFileWorkspace(entry.files);
        } else {
            if (entry.editable) {
                details.options!.editable = true;
            }
            if (entry.sheet) {
                details.options!.sheet = entry.sheet;
            }
        }

        await connectionManager.saveConnection(details);
        created.push(name);

        const missing = entry.files.filter(filePath => !toFileInfo(filePath).exists);
        if (missing.length > 0) {
            warnings.push(`'${name}': ${missing.length} file(s) not found on this machine (${missing.join(', ')}).`);
        }
    }

    return { created, skipped, warnings };
}
