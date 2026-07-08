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

const MYSQL_MAX_VARCHAR_LENGTH = 65535;
const MYSQL_MAX_CHAR_LENGTH = 255;

function mapImportTypeToMySqlType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return 'DATETIME';
    }
    if (baseType === 'BOOLEAN') {
        return 'BOOLEAN';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        return match ? `DECIMAL(${match[2]},${match[3]})` : 'DECIMAL(38,10)';
    }
    if (baseType === 'NVARCHAR' || baseType === 'VARCHAR') {
        const match = normalized.match(/^(N?VARCHAR)\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[2]) : 255, MYSQL_MAX_VARCHAR_LENGTH));
        return `VARCHAR(${length})`;
    }
    if (baseType === 'CHAR') {
        const match = normalized.match(/^CHAR\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[1]) : 1, MYSQL_MAX_CHAR_LENGTH));
        return `CHAR(${length})`;
    }
    if (baseType === 'TEXT') {
        return 'TEXT';
    }

    return normalized;
}

function toMySqlLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (['BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL'].includes(baseType)) {
        return value;
    }
    if (baseType === 'BOOLEAN') {
        return value === '0' || value.toLowerCase() === 'false' ? 'FALSE' : 'TRUE';
    }

    return `'${value.replace(/'/g, "''")}'`;
}

export const mysqlBatchImportConfig: BatchImportDialectConfig = {
    kind: 'mysql',
    label: 'MySQL',
    insertBatchSize: 200,
    mapImportType: mapImportTypeToMySqlType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'mysql', {
            supportsThreePartName: false
        });
    },
    toSqlLiteral: toMySqlLiteral,
    beginTransactionSql: 'START TRANSACTION',
    commitTransactionSql: 'COMMIT',
    rollbackTransactionSql: 'ROLLBACK'
};

export async function importDataToMySql(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    return importDataWithBatching(
        mysqlBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions
    );
}

export async function importClipboardDataToMySql(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    return importClipboardWithBatching(
        mysqlBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback
    );
}
