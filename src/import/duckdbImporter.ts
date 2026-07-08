import type { ConnectionDetails } from '../types';
import type { ImportColumnOptions, ImportResult, ProgressCallback } from './dataImporter';
import {
    BatchImportDialectConfig,
    importClipboardWithBatching,
    importDataWithBatching,
    parseImportTargetTable,
    type PreparedImportColumnDescriptor
} from './batchImportSupport';
import { getBaseDataType, normalizeDataType } from './dataImporter';

function mapImportTypeToDuckDbType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return 'TIMESTAMP';
    }
    if (baseType === 'BOOLEAN') {
        return 'BOOLEAN';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        return match ? `DECIMAL(${match[2]},${match[3]})` : 'DECIMAL(38,10)';
    }
    if (baseType === 'NVARCHAR' || baseType === 'VARCHAR' || baseType === 'TEXT') {
        return 'VARCHAR';
    }

    return normalized;
}

function toDuckDbLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (['BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'BOOLEAN'].includes(baseType)) {
        return value;
    }

    return `'${value.replace(/'/g, "''")}'`;
}

export const duckdbBatchImportConfig: BatchImportDialectConfig = {
    kind: 'duckdb',
    label: 'DuckDB',
    insertBatchSize: 300,
    mapImportType: mapImportTypeToDuckDbType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'duckdb');
    },
    toSqlLiteral: toDuckDbLiteral,
    beginTransactionSql: 'BEGIN TRANSACTION',
    commitTransactionSql: 'COMMIT',
    rollbackTransactionSql: 'ROLLBACK'
};

export async function importDataToDuckDb(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    return importDataWithBatching(
        duckdbBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions
    );
}

export async function importClipboardDataToDuckDb(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    return importClipboardWithBatching(
        duckdbBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback
    );
}
