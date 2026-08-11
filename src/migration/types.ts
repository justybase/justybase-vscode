/**
 * Shared contracts for the cross-database migration feature.
 */

import type { DatabaseKind } from '../contracts/database';
import type { ConnectionDetails } from '../types';

export type MigrationSourceMode = 'table' | 'sql';

export interface MigrationSourceTableSelection {
    mode: 'table';
    connectionName: string;
    database?: string;
    schema?: string;
    table: string;
}

export interface MigrationSourceSqlSelection {
    mode: 'sql';
    connectionName: string;
    sql: string;
}

export type MigrationSourceSelection =
    | MigrationSourceTableSelection
    | MigrationSourceSqlSelection;

export interface MigrationTargetSelection {
    connectionName: string;
    database?: string;
    schema?: string;
    table: string;
    /** Insert into an existing target table instead of creating a new one. */
    appendToExistingTable: boolean;
}

export interface MigrationRequest {
    source: MigrationSourceSelection;
    target: MigrationTargetSelection;
    /** Sample size used for data-driven type refinement (default 100). */
    sampleSize?: number;
}

/**
 * A single column mapping between source and target.
 */
export interface MigrationColumnMapping {
    /** Positional index in the source result set / table. */
    sourceIndex: number;
    sourceName: string;
    /** Original source type as reported by the source database. */
    sourceType: string;
    /** Canonical import type (BIGINT, NUMERIC(p,s), NVARCHAR(n), ...). */
    targetType: string;
    /** Rendered dialect-specific target type (shown in the mapping grid). */
    targetTypeDisplay: string;
    targetName: string;
    notNull: boolean;
    isPk: boolean;
    /** Sanitized simple literal default value (target dialect-safe) or undefined. */
    defaultValue?: string;
    /** Warning produced during type translation (e.g. unsupported precision). */
    warning?: string;
}

export interface MigrationPlan {
    sourceKind: DatabaseKind;
    targetKind: DatabaseKind;
    sourceMode: MigrationSourceMode;
    columns: MigrationColumnMapping[];
    createTableDdl: string;
    /** Dialect-specific load SQL (empty for batched INSERT dialects). */
    loadSql?: string;
    warnings: string[];
    /** Total row estimate from `SELECT COUNT(*)` (undefined when count failed). */
    totalRows?: number;
    targetQualifiedName: string;
}

export type MigrationPhase =
    | 'count'
    | 'stream'
    | 'finalize'
    | 'done'
    | 'error'
    | 'cancelled';

export interface MigrationProgress {
    phase: MigrationPhase;
    totalRows?: number;
    /** Rows read from the source reader. */
    rowsRead: number;
    /** 0..100; stays at 100 while the target is finalizing. */
    percent: number;
    message: string;
    elapsedSeconds: number;
}

export type MigrationProgressCallback = (progress: MigrationProgress) => void;

export interface MigrationResult {
    success: boolean;
    message: string;
    rowsInserted: number;
    elapsedSeconds: number;
    warnings: string[];
    plan?: MigrationPlan;
}

export interface MigrationSourceContext {
    kind: DatabaseKind;
    connectionDetails: ConnectionDetails;
    /** Fully qualified source reference used in FROM clauses (for table mode). */
    qualifiedTableName?: string;
}
