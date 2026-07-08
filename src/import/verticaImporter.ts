import type { ConnectionDetails } from '../types';
import type { ImportColumnOptions, ImportResult, ProgressCallback } from './dataImporter';
import {
    BatchImportDialectConfig,
    importClipboardWithBatching,
    importDataWithBatching,
    normalizeImportedLiteralValue,
    parseImportTargetTable,
    type PreparedImportColumnDescriptor
} from './batchImportSupport';
import { getBaseDataType, normalizeDataType } from './dataImporter';
import { formatIdentifierForSql } from '../utils/identifierUtils';

const VERTICA_MAX_VARCHAR_LENGTH = 65000;
const VERTICA_MAX_CHAR_LENGTH = 65000;
const VERTICA_MAX_VARBINARY_LENGTH = 65000;

function mapImportTypeToVerticaType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'DATETIME') {
        return 'TIMESTAMP';
    }
    if (baseType === 'TIMESTAMP WITH TIME ZONE') {
        return 'TIMESTAMPTZ';
    }
    if (baseType === 'BOOLEAN') {
        return 'BOOLEAN';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        return match ? `NUMERIC(${match[2]},${match[3]})` : 'NUMERIC(38,10)';
    }
    if (baseType === 'NVARCHAR' || baseType === 'VARCHAR') {
        const match = normalized.match(/^(N?VARCHAR)\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[2]) : 255, VERTICA_MAX_VARCHAR_LENGTH));
        return `VARCHAR(${length})`;
    }
    if (baseType === 'CHAR' || baseType === 'CHARACTER') {
        const match = normalized.match(/^CHAR(ACTER)?\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[2]) : 1, VERTICA_MAX_CHAR_LENGTH));
        return `CHAR(${length})`;
    }
    if (baseType === 'VARBINARY' || baseType === 'BINARY') {
        const match = normalized.match(/^(VARBINARY|BINARY)\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[2]) : 255, VERTICA_MAX_VARBINARY_LENGTH));
        return `VARBINARY(${length})`;
    }
    if (baseType === 'TEXT' || baseType === 'LONGVARCHAR' || baseType === 'LONG VARCHAR') {
        return 'LONG VARCHAR';
    }

    return normalized;
}

function escapeLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function toVerticaLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (['BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'DOUBLE PRECISION', 'REAL'].includes(baseType)) {
        return value;
    }
    if (baseType === 'BOOLEAN') {
        return value === '0' || value.toLowerCase() === 'false' ? 'FALSE' : 'TRUE';
    }
    if (baseType === 'DATE') {
        return `DATE '${escapeLiteral(value)}'`;
    }
    if (baseType === 'TIMESTAMP' || baseType === 'TIMESTAMPTZ') {
        return `TIMESTAMP '${escapeLiteral(value)}'`;
    }

    return `'${escapeLiteral(value)}'`;
}

function buildVerticaInsertSql(
    target: ReturnType<typeof parseImportTargetTable>,
    columns: PreparedImportColumnDescriptor[],
    rows: string[][],
    decimalDelimiter: string
): string {
    const columnList = columns
        .map((column) => formatIdentifierForSql(column.columnName, 'vertica'))
        .join(', ');
    const selectRows = rows.map((row, index) => {
        const literals = columns.map((column) =>
            toVerticaLiteral(
                normalizeImportedLiteralValue(
                    row[column.sourceIndex] ?? '',
                    column.sourceDataType,
                    column.targetDataType,
                    decimalDelimiter
                ),
                column
            )
        );
        return `${index === 0 ? 'SELECT' : 'UNION ALL SELECT'} ${literals.join(', ')}`;
    });

    return `INSERT INTO ${target.qualifiedName} (${columnList})\n${selectRows.join('\n')}`;
}

export const verticaBatchImportConfig: BatchImportDialectConfig = {
    kind: 'vertica',
    label: 'Vertica',
    insertBatchSize: 200,
    mapImportType: mapImportTypeToVerticaType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'vertica', {
            supportsThreePartName: false
        });
    },
    toSqlLiteral: toVerticaLiteral,
    beginTransactionSql: 'BEGIN',
    commitTransactionSql: 'COMMIT',
    rollbackTransactionSql: 'ROLLBACK',
    buildInsertSql(target, columns, rows, decimalDelimiter) {
        return buildVerticaInsertSql(target, columns, rows, decimalDelimiter);
    }
};

export async function importDataToVertica(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    return importDataWithBatching(
        verticaBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions
    );
}

export async function importClipboardDataToVertica(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    return importClipboardWithBatching(
        verticaBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback
    );
}
