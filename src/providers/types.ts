/**
 * Common types for SQL completion functionality
 */

export interface LocalDefinition {
    name: string;
    type: string;
    columns: string[];
    /** Optional source range for block-scoped definitions such as PL/SQL locals. */
    scopeStart?: number;
    scopeEnd?: number;
}

export interface AliasInfo {
    db?: string;
    schema?: string;
    table: string;
}

export interface TableReference {
    db?: string;
    schema?: string;
    table: string;
    alias: string;
}

export interface ParsedContext {
    version: number;
    contentHash?: string;
    cleanText: string;
    localDefs: LocalDefinition[];
    variables: string[];
}

export interface PatternMatch {
    matched: boolean;
    data?: unknown;
}

export interface JoinOnMatch {
    tableRef: string;
    alias?: string;
    typedPrefix?: string;
}

export interface DbMatch {
    dbName: string;
    partial: string;
}

export interface SchemaMatch {
    dbName: string;
    schemaName: string;
    partial: string;
}

export interface TableMatch {
    dbName: string;
    schemaName?: string;
    partial: string;
}
