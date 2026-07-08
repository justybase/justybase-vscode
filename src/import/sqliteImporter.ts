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

function mapImportTypeToSqliteType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (['BIGINT', 'INT', 'INTEGER', 'SMALLINT'].includes(baseType)) {
        return 'INTEGER';
    }
    if (baseType === 'BOOLEAN') {
        return 'INTEGER';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        return match ? `NUMERIC(${match[2]},${match[3]})` : 'NUMERIC';
    }
    if (baseType === 'DATE') {
        return 'DATE';
    }
    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return 'TIMESTAMP';
    }

    return 'TEXT';
}

function toSqliteLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (['INTEGER', 'NUMERIC', 'REAL', 'FLOAT', 'DOUBLE'].includes(baseType)) {
        return value;
    }

    return `'${value.replace(/'/g, "''")}'`;
}

export const sqliteBatchImportConfig: BatchImportDialectConfig = {
    kind: 'sqlite',
    label: 'SQLite',
    insertBatchSize: 300,
    mapImportType: mapImportTypeToSqliteType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'sqlite', {
            supportsThreePartName: false
        });
    },
    toSqlLiteral: toSqliteLiteral,
    beginTransactionSql: 'BEGIN TRANSACTION',
    commitTransactionSql: 'COMMIT',
    rollbackTransactionSql: 'ROLLBACK'
};

export async function importDataToSqlite(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    return importDataWithBatching(
        sqliteBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions
    );
}

export async function importClipboardDataToSqlite(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    return importClipboardWithBatching(
        sqliteBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback
    );
}
