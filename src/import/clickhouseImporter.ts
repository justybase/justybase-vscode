import type { ConnectionDetails } from '../types';
import type { ImportColumnOptions, ImportResult, ProgressCallback } from './dataImporter';
import {
    BatchImportDialectConfig,
    buildBatchCreateTablePreview,
    buildBatchLoadPreview,
    importClipboardWithBatching,
    importDataWithBatching,
    parseImportTargetTable,
    type PreparedImportColumnDescriptor,
} from './batchImportSupport';
import { getBaseDataType, normalizeDataType } from './dataImporter';
import { formatIdentifierForSql } from '../utils/identifierUtils';

function mapImportTypeToClickHouseType(typeName: string): string {
    const normalized = normalizeDataType(typeName).trim().toUpperCase();
    const baseType = getBaseDataType(normalized);

    if (normalized.startsWith('INT') || normalized.startsWith('BIGINT')) {
        return normalized.includes('UNSIGNED') ? 'UInt64' : 'Int64';
    }
    if (['SMALLINT', 'TINYINT', 'INTEGER', 'INT'].includes(baseType)) {
        return 'Int64';
    }
    if (['FLOAT', 'REAL', 'DOUBLE'].includes(baseType)) {
        return 'Float64';
    }
    if (baseType === 'BOOLEAN' || baseType === 'BIT') {
        return 'Bool';
    }
    if (baseType === 'DATE') {
        return 'Date';
    }
    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return 'DateTime64(3)';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL' || baseType === 'NUMBER') {
        const match = normalized.match(/(?:NUMERIC|DECIMAL|NUMBER)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
        return match ? `Decimal(${match[1]},${match[2]})` : 'Decimal(38,10)';
    }
    if (baseType === 'UUID') {
        return 'UUID';
    }
    if (baseType === 'JSON') {
        return 'String';
    }
    if (baseType === 'TEXT' || baseType === 'VARCHAR' || baseType === 'NVARCHAR' || baseType === 'CHAR' || baseType === 'CLOB') {
        return 'String';
    }

    return normalized || 'String';
}

function toClickHouseLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const type = column.targetDataType.trim().toUpperCase();
    if (/^(U?INT|FLOAT|DECIMAL)/.test(type) || type === 'BOOL') {
        if (type === 'BOOL') {
            return /^(1|TRUE|T|YES|Y)$/i.test(value) ? 'true' : 'false';
        }
        return value.replace(',', '.');
    }

    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function makeClickHouseImportTypeNullable(typeName: string): string {
    const trimmed = typeName.trim() || 'String';
    if (/^Nullable\s*\(/i.test(trimmed) || /^(Array|Map|Tuple|Nested)\s*\(/i.test(trimmed)) {
        return trimmed;
    }
    return `Nullable(${trimmed})`;
}

export const clickhouseBatchImportConfig: BatchImportDialectConfig = {
    kind: 'clickhouse',
    label: 'ClickHouse',
    insertBatchSize: 500,
    mapImportType: mapImportTypeToClickHouseType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'clickhouse', {
            supportsThreePartName: false,
        });
    },
    toSqlLiteral: toClickHouseLiteral,
    buildCreateTableSql(target, columns) {
        const columnDefinitions = columns.map(column =>
            `    ${formatIdentifierForSql(column.columnName, 'clickhouse')} ${makeClickHouseImportTypeNullable(column.targetDataType)}`,
        );
        return [
            `CREATE TABLE ${target.qualifiedName} (`,
            columnDefinitions.join(',\n'),
            ') ENGINE = MergeTree',
            'ORDER BY tuple();',
        ].join('\n');
    },
};

export function buildClickHouseCreateTablePreview(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    columns: import('./dataImporter').ImportColumnDescriptor[],
): string {
    return buildBatchCreateTablePreview(clickhouseBatchImportConfig, targetTable, connectionDetails, columns);
}

export function buildClickHouseLoadPreview(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    columns: import('./dataImporter').ImportColumnDescriptor[],
    previewRows: string[][],
    decimalDelimiter: string,
): string | undefined {
    return buildBatchLoadPreview(
        clickhouseBatchImportConfig,
        targetTable,
        connectionDetails,
        columns,
        previewRows,
        decimalDelimiter,
    );
}

export async function importDataToClickHouse(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions,
): Promise<ImportResult> {
    return importDataWithBatching(
        clickhouseBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions,
    );
}

export async function importClipboardDataToClickHouse(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback,
): Promise<ImportResult> {
    return importClipboardWithBatching(
        clickhouseBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback,
    );
}
