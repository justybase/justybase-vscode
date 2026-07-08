/**
 * Path helpers for on-disk metadata cache (v2 layout).
 */

import * as path from 'path';
import { sanitizeConnectionNameForLock } from './metadataDiskLock';

export const CACHE_V2_DIR_NAME = 'metadata-cache-v2';
export const LEGACY_CACHE_FILE_NAME = 'metadata-cache-v1.json.gz';
export const V2_INDEX_FILE_NAME = 'index.json.gz';
export const V2_METADATA_FILE_NAME = 'metadata.json.gz';
export const V3_MANIFEST_FILE_NAME = 'metadata-manifest.json.gz';
export const V2_COLUMNS_FILE_SUFFIX = '.columns.json.gz';

/** @deprecated Legacy lossy sanitizer — used only to load pre-v2 column files. */
export function sanitizeFileNameSegment(name: string): string {
    return name.replace(/[/\\:*?"<>|]/g, '_');
}

/**
 * Reversible, collision-free filename segment for a database name.
 * Uses base64url so `PROD:1` and `PROD_1` map to distinct paths.
 */
export function encodeDatabaseFileSegment(databaseName: string): string {
    return Buffer.from(databaseName, 'utf8').toString('base64url');
}

export function decodeDatabaseFileSegment(segment: string): string | undefined {
    try {
        return Buffer.from(segment, 'base64url').toString('utf8');
    } catch {
        return undefined;
    }
}

export function getCacheV2Dir(storageDir: string): string {
    return path.join(storageDir, CACHE_V2_DIR_NAME);
}

export function getV2IndexPath(storageDir: string): string {
    return path.join(getCacheV2Dir(storageDir), V2_INDEX_FILE_NAME);
}

export function getConnectionDir(storageDir: string, connectionName: string): string {
    return path.join(getCacheV2Dir(storageDir), sanitizeConnectionNameForLock(connectionName));
}

export function getConnectionMetadataPath(storageDir: string, connectionName: string): string {
    return path.join(getConnectionDir(storageDir, connectionName), V2_METADATA_FILE_NAME);
}

export function getConnectionManifestPath(storageDir: string, connectionName: string): string {
    return path.join(getConnectionDir(storageDir, connectionName), V3_MANIFEST_FILE_NAME);
}

export function getColumnFilePath(
    storageDir: string,
    connectionName: string,
    databaseName: string,
): string {
    const segment = encodeDatabaseFileSegment(databaseName);
    return path.join(
        getConnectionDir(storageDir, connectionName),
        `${segment}${V2_COLUMNS_FILE_SUFFIX}`,
    );
}

/** Legacy sanitized path for column files written before base64url encoding. */
export function getLegacySanitizedColumnFilePath(
    storageDir: string,
    connectionName: string,
    databaseName: string,
): string {
    const safeDb = sanitizeFileNameSegment(databaseName);
    return path.join(
        getConnectionDir(storageDir, connectionName),
        `${safeDb}${V2_COLUMNS_FILE_SUFFIX}`,
    );
}

export function databaseFileSegmentFromColumnFileName(fileName: string): string | undefined {
    if (!fileName.endsWith(V2_COLUMNS_FILE_SUFFIX)) {
        return undefined;
    }
    return fileName.slice(0, -V2_COLUMNS_FILE_SUFFIX.length);
}

/** @deprecated Use databaseFileSegmentFromColumnFileName */
export function databaseNameFromColumnFileName(fileName: string): string | undefined {
    const segment = databaseFileSegmentFromColumnFileName(fileName);
    if (!segment) {
        return undefined;
    }
    const decoded = decodeDatabaseFileSegment(segment);
    return decoded ?? segment;
}

/**
 * Extract database name from a column layer key (e.g. DB1.SCHEMA.TABLE or DB..TABLE).
 */
export function extractDatabaseFromLayerKey(layerKey: string): string {
    const doubleDotIndex = layerKey.indexOf('..');
    if (doubleDotIndex > 0) {
        return layerKey.slice(0, doubleDotIndex);
    }
    const dotIndex = layerKey.indexOf('.');
    if (dotIndex > 0) {
        return layerKey.slice(0, dotIndex);
    }
    return layerKey;
}

export function isActiveColumnFileEntry(
    fileSegment: string,
    activeDatabases: readonly string[],
): boolean {
    const activeSegments = new Set(activeDatabases.map(encodeDatabaseFileSegment));
    if (activeSegments.has(fileSegment)) {
        return true;
    }
    // Keep legacy sanitized files until rewritten on next save.
    return activeDatabases.some(
        (databaseName) => sanitizeFileNameSegment(databaseName) === fileSegment,
    );
}
