/**
 * Metadata Cache - Types
 */

/**
 * Per-key cache entry with individual timestamps
 */
export interface PerKeyEntry<T> {
    data: T;
    timestamp: number;
}

/**
 * Cache type identifiers for selective saving
 */
export type CacheType = 'db' | 'schema' | 'table' | 'column';

/**
 * Search result item
 */
export interface SearchResult {
    name: string;
    type: string;
    database?: string;
    schema?: string;
    parent?: string; // For columns - the parent table name
    connectionName?: string;
    description?: string;
    matchType?: string;
    dataType?: string;
}

/**
 * Object with type information from cache
 */
export interface CachedObjectInfo {
    objId: number;
    objType: string;
    schema: string;
    name: string;
}

export interface DatabaseMetadata {
    DATABASE: string;
    label?: string;
    detail?: string;
    kind?: number;
    [key: string]: unknown;
}

export interface SchemaMetadata {
    SCHEMA: string;
    OWNER?: string;
    label?: string;
    detail?: string;
    kind?: number;
    insertText?: string;
    sortText?: string;
    filterText?: string;
    [key: string]: unknown;
}

export interface TableMetadata {
    OBJNAME?: string;
    TABLENAME?: string;
    OBJID?: number;
    SCHEMA?: string;
    OWNER?: string;
    DESCRIPTION?: string;
    kind?: number;
    objType?: string;
    TYPE?: string;
    label?: string | { label: string };
    detail?: string;
    sortText?: string;
    [key: string]: unknown;
}

export interface ProcedureMetadata {
    PROCEDURE: string;
    PROCEDURESIGNATURE?: string;
    SCHEMA?: string;
    OWNER?: string;
    DATABASE?: string;
    kind?: number;
    label?: string | { label: string };
    detail?: string;
    sortText?: string;
    [key: string]: unknown;
}

export interface ColumnMetadata {
    ATTNAME: string;
    FORMAT_TYPE: string;
    label?: string;
    detail?: string;
    kind?: number;
    documentation?: string;
    isPk?: boolean;
    isFk?: boolean;
    isDistributionKey?: boolean;
    [key: string]: unknown;
}

/**
 * Object with schema information
 */
export interface ObjectWithSchema {
    item: TableMetadata;
    schema: string;
    objId?: number;
    owner?: string;
    description?: string;
}
