import type { ConnectionDetails } from '../types';
import type { ImportColumnOptions, ImportResult, ProgressCallback } from './dataImporter';
import {
    BatchImportDialectConfig,
    importClipboardWithBatching,
    importDataWithBatching,
    normalizeImportedLiteralValue,
    parseImportTargetTable,
    type BatchImportTargetTable,
    type PreparedImportColumnDescriptor
} from './batchImportSupport';
import { getBaseDataType, normalizeDataType } from './dataImporter';
import { formatIdentifierForSql } from '../utils/identifierUtils';

const ORACLE_MAX_VARCHAR_LENGTH = 4000;
const ORACLE_MAX_CHAR_LENGTH = 2000;

function mapImportTypeToOracleType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'BIGINT') {
        return 'NUMBER(19,0)';
    }
    if (baseType === 'INT' || baseType === 'INTEGER') {
        return 'NUMBER(10,0)';
    }
    if (baseType === 'SMALLINT') {
        return 'NUMBER(5,0)';
    }
    if (baseType === 'BOOLEAN') {
        return 'NUMBER(1)';
    }
    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        return match ? `NUMBER(${match[2]},${match[3]})` : 'NUMBER(38,10)';
    }
    if (baseType === 'NVARCHAR' || baseType === 'VARCHAR') {
        const match = normalized.match(/^(N?VARCHAR)\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[2]) : 255, ORACLE_MAX_VARCHAR_LENGTH));
        return `VARCHAR2(${length} CHAR)`;
    }
    if (baseType === 'CHAR') {
        const match = normalized.match(/^CHAR\(\s*(\d+)\s*\)$/);
        const length = Math.max(1, Math.min(match ? Number(match[1]) : 1, ORACLE_MAX_CHAR_LENGTH));
        return `CHAR(${length})`;
    }
    if (baseType === 'TEXT') {
        return 'CLOB';
    }
    if (baseType === 'DATE') {
        return 'DATE';
    }
    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return 'TIMESTAMP';
    }

    return normalized;
}

function toOracleLiteral(value: string | null, column: PreparedImportColumnDescriptor): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(column.targetDataType);
    if (['NUMBER', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE'].includes(baseType)) {
        return value;
    }
    if (baseType === 'DATE') {
        return `TO_DATE('${value.replace(/'/g, "''")}', 'YYYY-MM-DD')`;
    }
    if (baseType === 'TIMESTAMP') {
        return `TO_TIMESTAMP('${value.replace(/'/g, "''")}', 'YYYY-MM-DD HH24:MI:SS')`;
    }

    return `'${value.replace(/'/g, "''")}'`;
}

function buildOracleInsertSql(
    target: BatchImportTargetTable,
    columns: PreparedImportColumnDescriptor[],
    rows: string[][],
    decimalDelimiter: string
): string {
    const columnList = columns.map(column => formatIdentifierForSql(column.columnName, 'oracle')).join(', ');
    const intoClauses = rows.map(row => {
        const values = columns.map(column => toOracleLiteral(
            normalizeImportedLiteralValue(
                row[column.sourceIndex] ?? '',
                column.sourceDataType,
                column.targetDataType,
                decimalDelimiter
            ),
            column
        ));
        return `    INTO ${target.qualifiedName} (${columnList}) VALUES (${values.join(', ')})`;
    });

    return `INSERT ALL\n${intoClauses.join('\n')}\nSELECT 1 FROM DUAL`;
}

export const oracleBatchImportConfig: BatchImportDialectConfig = {
    kind: 'oracle',
    label: 'Oracle',
    insertBatchSize: 100,
    mapImportType: mapImportTypeToOracleType,
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails) {
        return parseImportTargetTable(targetTable, connectionDetails, 'oracle', {
            supportsThreePartName: false
        });
    },
    toSqlLiteral: toOracleLiteral,
    commitTransactionSql: 'COMMIT',
    rollbackTransactionSql: 'ROLLBACK',
    buildInsertSql(target, columns, rows, decimalDelimiter) {
        return buildOracleInsertSql(target, columns, rows, decimalDelimiter);
    }
};

export async function importDataToOracle(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    return importDataWithBatching(
        oracleBatchImportConfig,
        filePath,
        targetTable,
        connectionDetails,
        progressCallback,
        timeoutSeconds,
        columnOptions
    );
}

export async function importClipboardDataToOracle(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    return importClipboardWithBatching(
        oracleBatchImportConfig,
        targetTable,
        connectionDetails,
        formatPreference,
        options,
        progressCallback
    );
}
