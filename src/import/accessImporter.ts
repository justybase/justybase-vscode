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

function mapImportTypeToAccessType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (['BIGINT', 'INT', 'INTEGER', 'SMALLINT'].includes(baseType)) {
        return 'INTEGER';
    }
    if (baseType === 'BOOLEAN' || baseType === 'BIT') {
        return 'BOOLEAN';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (match) {
            const precision = Math.min(28, Number(match[2]));
            const scale = Math.min(15, Number(match[3]));
            return `DECIMAL(${precision},${scale})`;
        }
        return 'DECIMAL(18,2)';
    }
    if (baseType === 'DATE' || baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return 'DATETIME';
    }
    if (baseType === 'VARCHAR' || baseType === 'NVARCHAR' || baseType === 'CHAR') {
        return 'TEXT(255)';
    }

    return 'MEMO';
}

function toAccessLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (['INTEGER', 'DECIMAL', 'NUMERIC', 'CURRENCY', 'DOUBLE', 'SINGLE'].includes(baseType)) {
        return value;
    }
    if (baseType === 'BOOLEAN') {
        const normalized = value.trim().toLowerCase();
        return ['true', 't', 'yes', 'y', '1'].includes(normalized) ? 'TRUE' : 'FALSE';
    }

    return `'${value.replace(/'/g, "''")}'`;
}

export const accessBatchImportConfig: BatchImportDialectConfig = {
    kind: 'access',
    label: 'Microsoft Access',
    insertBatchSize: 50,
    mapImportType: mapImportTypeToAccessType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'access', {
            supportsThreePartName: false
        });
    },
    toSqlLiteral: toAccessLiteral
};

export async function importDataToAccess(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    return importDataWithBatching(
        accessBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions
    );
}

export async function importClipboardDataToAccess(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    return importClipboardWithBatching(
        accessBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback
    );
}
