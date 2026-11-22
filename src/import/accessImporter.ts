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
import type { ImportCancellationCheck } from './importCancellation';

/**
 * Maps a generic source type to an Access/Jet DDL type.
 *
 * `INTEGER`/`INT` are 4-byte Long Integer in Access DDL, while `SMALLINT`
 * is a 2-byte Integer.  Text lengths are characters (`TEXT(n)`), and values
 * that cannot fit into 255 characters must use `MEMO` instead of being
 * silently truncated.
 */
export function mapImportTypeToAccessType(typeName: string, supportsBigInt = true): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'BIGINT' || baseType === 'INT8' || baseType === 'BIGINTEGER') {
        if (!supportsBigInt) {
            throw new Error(
                'Access .mdb (Jet 4) cannot store BIGINT columns; '
                + 'import into an .accdb database or convert the column to LONG.',
            );
        }
        return 'BIGINT';
    }
    if (baseType === 'BYTE' || baseType === 'TINYINT') {
        return 'BYTE';
    }
    if (['SMALLINT', 'SHORT', 'SHORTINTEGER', 'INT2'].includes(baseType)) {
        return 'SMALLINT';
    }
    if (['INT', 'INTEGER', 'INT4', 'MEDIUMINT', 'LONGINTEGER'].includes(baseType)) {
        return 'LONG';
    }
    if (baseType === 'BOOLEAN' || baseType === 'BIT' || baseType === 'YESNO' || baseType === 'LOGICAL') {
        return 'BOOLEAN';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL' || baseType === 'NUMBER') {
        const match = normalized.match(/\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/);
        const precision = Math.min(28, Math.max(1, match ? Number(match[1]) : 18));
        const scale = Math.min(precision, Math.max(0, match?.[2] ? Number(match[2]) : 2));
        return `DECIMAL(${precision},${scale})`;
    }
    if (baseType === 'MONEY' || baseType === 'CURRENCY' || baseType === 'SMALLMONEY') {
        return 'CURRENCY';
    }
    if (['REAL', 'FLOAT4', 'SINGLE'].includes(baseType)) {
        return 'SINGLE';
    }
    if (['FLOAT', 'FLOAT8', 'DOUBLE', 'DOUBLE PRECISION'].includes(baseType)) {
        return 'DOUBLE';
    }
    if (['DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME'].includes(baseType)) {
        return 'DATETIME';
    }
    if (['UUID', 'UNIQUEIDENTIFIER', 'GUID', 'REPLICATIONID'].includes(baseType)) {
        return 'GUID';
    }
    if (['BINARY', 'VARBINARY', 'BLOB', 'IMAGE', 'BYTEA', 'OLE', 'LONGBINARY', 'LONGVARBINARY', 'GENERAL'].includes(baseType)) {
        return 'OLE';
    }
    if (['CLOB', 'LONGTEXT', 'MEMO', 'NTEXT', 'JSON', 'JSONB'].includes(baseType)) {
        return 'MEMO';
    }
    if (['VARCHAR', 'NVARCHAR', 'CHAR', 'NCHAR', 'CHARACTER', 'STRING', 'BPCHAR', 'TEXT'].includes(baseType)) {
        const lengthMatch = normalized.match(/\(\s*(\d+)\s*\)/);
        if (!lengthMatch && baseType === 'TEXT') {
            return 'MEMO';
        }
        const length = lengthMatch ? Number(lengthMatch[1]) : 255;
        if (length > 255) {
            return 'MEMO';
        }
        return `TEXT(${Math.max(1, length)})`;
    }

    return 'MEMO';
}

function targetSupportsBigInt(connectionDetails: ConnectionDetails): boolean {
    const database = connectionDetails.database?.trim();
    return !database || !/\.mdb$/i.test(database);
}

function configForTarget(connectionDetails: ConnectionDetails): BatchImportDialectConfig {
    const supportsBigInt = targetSupportsBigInt(connectionDetails);
    return {
        ...accessBatchImportConfig,
        mapImportType: (typeName: string) => mapImportTypeToAccessType(typeName, supportsBigInt),
    };
}

const ACCESS_NUMERIC_TYPES = new Set([
    'INTEGER', 'LONG', 'SHORT', 'SMALLINT', 'BYTE', 'BIGINT',
    'DECIMAL', 'NUMERIC', 'CURRENCY', 'DOUBLE', 'SINGLE',
]);

function toAccessLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (ACCESS_NUMERIC_TYPES.has(baseType)) {
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
    toSqlLiteral: toAccessLiteral,
    cleanupCreatedTargetOnFailure: true,
    buildDropTableSql(target) {
        return `DROP TABLE ${target.qualifiedName}`;
    }
};

export async function importDataToAccess(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions,
    isCancelled?: ImportCancellationCheck
): Promise<ImportResult> {
    return importDataWithBatching(
        configForTarget(connectionDetails),
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions,
        isCancelled
    );
}

export async function importClipboardDataToAccess(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback,
    isCancelled?: ImportCancellationCheck
): Promise<ImportResult> {
    return importClipboardWithBatching(
        configForTarget(connectionDetails),
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback,
        isCancelled
    );
}
