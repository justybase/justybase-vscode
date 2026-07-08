/**
 * Serializable on-disk metadata cache types (schema v1 legacy + v2 split layout).
 */

import type {
    ColumnMetadata,
    DatabaseMetadata,
    ProcedureMetadata,
    SchemaMetadata,
    TableMetadata,
} from '../types';

/** Legacy monolithic cache file schema version */
export const LEGACY_CACHE_SCHEMA_VERSION = 1;
/** Per-file schema version for v2 metadata blobs and v2 expanded column blobs */
export const CACHE_SCHEMA_VERSION = 2;
/** Small startup manifest schema version for progressive metadata hydration. */
export const METADATA_MANIFEST_SCHEMA_VERSION = 3;
/** Dictionary-encoded column file schema version */
export const COLUMN_FILE_SCHEMA_VERSION = 3;

export const COLUMN_FLAG_PK = 1;
export const COLUMN_FLAG_FK = 2;
export const COLUMN_FLAG_DISTRIBUTION_KEY = 4;

/** @deprecated Use LEGACY_CACHE_FILE_NAME from metadataDiskPaths */
export const CACHE_FILE_NAME = 'metadata-cache-v1.json.gz';

export const DOCUMENTATION_MAX_LENGTH = 200;
export const MAX_STORED_CONNECTIONS = 10;
export const ORPHAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FILE_WARN_BYTES = 20 * 1024 * 1024;
export const SAVE_DEBOUNCE_MS = 5_000;

export interface SerializedLayerEntry<T> {
    timestamp: number;
    data: T[];
}

export interface SerializedStringLayerEntry {
    timestamp: number;
    data: string[];
}

/** Metadata layers without columns (v2 metadata.json.gz payload). */
export interface SerializedConnectionMetadata {
    prefetchCompletedAt: number;
    connectionFingerprint: string;
    database: SerializedLayerEntry<DatabaseMetadata>;
    schema: Record<string, SerializedLayerEntry<SchemaMetadata>>;
    table: Record<string, SerializedLayerEntry<TableMetadata>>;
    procedure: Record<string, SerializedLayerEntry<ProcedureMetadata>>;
    typeGroup: Record<string, SerializedStringLayerEntry>;
}

/** Small per-connection manifest loaded during activation before full metadata hydrate. */
export interface SerializedConnectionManifest {
    schemaVersion: number;
    prefetchCompletedAt: number;
    connectionFingerprint: string;
    database: SerializedLayerEntry<DatabaseMetadata>;
    columnDatabases: string[];
    isComplete?: boolean;
}

/** Expanded column layers for one database (legacy v2 {DB}.columns.json.gz payload). */
export interface SerializedColumnFileV2 {
    schemaVersion: 2;
    database: string;
    column: Record<string, SerializedLayerEntry<ColumnMetadata>>;
}

export interface EncodedColumnRecord {
    schema: number;
    table: number;
    type: number;
    name: string;
    flags: number;
    doc?: number;
}

export interface EncodedColumnLayer {
    timestamp: number;
    columns: EncodedColumnRecord[];
}

/** Dictionary-encoded column file (v3 {DB}.columns.json.gz payload). */
export interface SerializedColumnFileV3 {
    schemaVersion: 3;
    database: string;
    schemas: string[];
    types: string[];
    tables: Array<{ schema: number; name: string }>;
    docs: string[];
    layers: Record<string, EncodedColumnLayer>;
}

export type SerializedColumnFile = SerializedColumnFileV2 | SerializedColumnFileV3;

/** v2 global index — small manifest for eviction and discovery. */
export interface V2DiskIndex {
    schemaVersion: number;
    writtenAt: number;
    connections: Record<string, V2ConnectionIndexEntry>;
}

export interface V2ConnectionIndexEntry {
    prefetchCompletedAt: number;
    connectionFingerprint: string;
    columnDatabases: string[];
    isComplete?: boolean;
}

/** Metadata loaded from disk without column layers (lazy column load). */
export interface LoadedConnectionMetadata extends SerializedConnectionMetadata {
    columnDatabases: string[];
}

/** Manifest loaded from disk without heavy metadata layers. */
export interface LoadedConnectionManifest extends SerializedConnectionManifest {
    hasManifestFile: boolean;
}

/** Legacy v1 full connection blob (used for migration and hydrate). */
export interface SerializedConnectionCache extends SerializedConnectionMetadata {
    column: Record<string, SerializedLayerEntry<ColumnMetadata>>;
}

/** Legacy v1 monolithic file. */
export interface SerializedCache {
    schemaVersion: number;
    writtenAt: number;
    connections: Record<string, SerializedConnectionCache>;
}

export function createEmptySerializedCache(): SerializedCache {
    return {
        schemaVersion: LEGACY_CACHE_SCHEMA_VERSION,
        writtenAt: Date.now(),
        connections: {},
    };
}

export function createEmptyV2Index(): V2DiskIndex {
    return {
        schemaVersion: CACHE_SCHEMA_VERSION,
        writtenAt: Date.now(),
        connections: {},
    };
}

export function isSerializedCache(value: unknown): value is SerializedCache {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const obj = value as Record<string, unknown>;
    return (
        typeof obj.schemaVersion === 'number'
        && typeof obj.writtenAt === 'number'
        && obj.connections !== null
        && typeof obj.connections === 'object'
    );
}

export function isV2DiskIndex(value: unknown): value is V2DiskIndex {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const obj = value as Record<string, unknown>;
    return (
        typeof obj.schemaVersion === 'number'
        && typeof obj.writtenAt === 'number'
        && obj.connections !== null
        && typeof obj.connections === 'object'
    );
}

export function isSerializedColumnFile(value: unknown): value is SerializedColumnFile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.schemaVersion !== 'number' || typeof obj.database !== 'string') {
        return false;
    }
    if (obj.schemaVersion === COLUMN_FILE_SCHEMA_VERSION) {
        return (
            Array.isArray(obj.schemas)
            && Array.isArray(obj.types)
            && Array.isArray(obj.tables)
            && Array.isArray(obj.docs)
            && obj.layers !== null
            && typeof obj.layers === 'object'
        );
    }
    if (obj.schemaVersion === CACHE_SCHEMA_VERSION) {
        return obj.column !== null && typeof obj.column === 'object';
    }
    return false;
}
