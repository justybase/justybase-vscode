import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseConnection } from '../contracts/database';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import type { ConnectionDetails } from '../types';
import { ClipboardDataProcessor } from './clipboardImporter';
import {
    buildWidthMismatchWarning,
    ImportColumnDescriptor,
    ImportColumnOptions,
    ImportResult,
    ProgressCallback
} from './dataImporter';
import { normalizeAndDeduplicateHeaders } from './importHeaderUtils';
import { createTabularDataImporter } from './tabularDataImporter';
import type { ImportCancellationCheck } from './importCancellation';
import { throwIfImportCancelled } from './importCancellation';
import { escapeSqlString as escapeSqlLiteral } from '../utils/sqlUtils';
import {
    isDashZeroImportCell,
    normalizeImportNumberForDb,
} from '@justybase/database-utils/importNumberParsing';

const MSSQL_MAX_VARCHAR_LENGTH = 8000;
const MSSQL_MAX_NVARCHAR_LENGTH = 4000;
const INSERT_BATCH_SIZE = 100;
const MSSQL_RESERVED_KEYWORDS = new Set([
    'ADD', 'ALTER', 'AND', 'AS', 'BY', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CURRENT', 'DATE',
    'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'EXISTS', 'FOREIGN', 'FROM', 'FULL', 'GROUP',
    'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'PROCEDURE', 'REFERENCES', 'RIGHT', 'SCHEMA',
    'SELECT', 'SET', 'TABLE', 'TIME', 'TIMESTAMP', 'TOP', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'VALUES',
    'VIEW', 'WHERE', 'GO', 'EXEC', 'EXECUTE', 'OUTPUT', 'IDENTITY'
]);

interface MsSqlTargetTable {
    providedDatabase?: string;
    schema?: string;
    table: string;
    qualifiedName: string;
    displayName: string;
}

function quoteIdentifier(identifier: string): string {
    return `[${identifier.replace(/]/g, ']]')}]`;
}

function formatIdentifier(identifier: string): string {
    if (/^[A-Z_][A-Z0-9_]*$/.test(identifier) && !MSSQL_RESERVED_KEYWORDS.has(identifier.toUpperCase())) {
        return identifier;
    }
    return quoteIdentifier(identifier);
}

function normalizeDataType(typeName: string): string {
    return typeName.trim().replace(/\s+/g, ' ').toUpperCase();
}

function getBaseDataType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const parenIndex = normalized.indexOf('(');
    return (parenIndex >= 0 ? normalized.slice(0, parenIndex) : normalized).trim();
}

function getNumericScale(typeName: string): number | null {
    const normalized = normalizeDataType(typeName);
    const match = normalized.match(/^(NUMERIC|DECIMAL)\(\s*\d+\s*,\s*(\d+)\s*\)$/);
    if (!match) {
        return null;
    }
    return Number(match[2]);
}

export function mapImportTypeToMsSqlType(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'DATETIME') {
        return 'DATETIME2';
    }

    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const numericMatch = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (numericMatch) {
            return `DECIMAL(${numericMatch[2]},${numericMatch[3]})`;
        }
        return 'DECIMAL(28,10)';
    }

    if (baseType === 'NVARCHAR') {
        const lengthMatch = normalized.match(/^NVARCHAR\(\s*(\d+)\s*\)$/);
        const parsedLength = lengthMatch ? Number(lengthMatch[1]) : 255;
        const boundedLength = Math.max(1, Math.min(parsedLength, MSSQL_MAX_NVARCHAR_LENGTH));
        return `NVARCHAR(${boundedLength})`;
    }

    if (baseType === 'VARCHAR') {
        const lengthMatch = normalized.match(/^VARCHAR\(\s*(\d+)\s*\)$/);
        const parsedLength = lengthMatch ? Number(lengthMatch[1]) : 255;
        const boundedLength = Math.max(1, Math.min(parsedLength, MSSQL_MAX_VARCHAR_LENGTH));
        return `VARCHAR(${boundedLength})`;
    }

    if (baseType === 'CHAR') {
        const lengthMatch = normalized.match(/^CHAR\(\s*(\d+)\s*\)$/);
        const parsedLength = lengthMatch ? Number(lengthMatch[1]) : 1;
        const boundedLength = Math.max(1, Math.min(parsedLength, MSSQL_MAX_VARCHAR_LENGTH));
        return `CHAR(${boundedLength})`;
    }

    return normalized;
}

export function parseMsSqlTargetTable(targetTable: string, connectionDetails: ConnectionDetails): MsSqlTargetTable {
    const parts = targetTable
        .split('.')
        .map(part => part.trim())
        .filter(part => part.length > 0);

    if (parts.length === 0 || parts.length > 3) {
        throw new Error('Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.');
    }

    if (parts.length === 1) {
        const table = parts[0];
        return {
            table,
            qualifiedName: formatIdentifier(table),
            displayName: table
        };
    }

    if (parts.length === 2) {
        const [schema, table] = parts;
        return {
            schema,
            table,
            qualifiedName: `${formatIdentifier(schema)}.${formatIdentifier(table)}`,
            displayName: `${schema}.${table}`
        };
    }

    const [providedDatabase, schema, table] = parts;
    const activeDatabase = (connectionDetails.database || '').trim();
    if (activeDatabase && providedDatabase.toUpperCase() !== activeDatabase.toUpperCase()) {
        throw new Error(
            `MSSQL import runs against active database "${activeDatabase}". ` +
            `Provided database "${providedDatabase}" does not match the active connection.`
        );
    }

    return {
        providedDatabase,
        schema,
        table,
        qualifiedName: `${formatIdentifier(schema)}.${formatIdentifier(table)}`,
        displayName: `${providedDatabase}.${schema}.${table}`
    };
}

function formatDateValue(value: string): string {
    const dateMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!dateMatch) {
        return value;
    }

    const [, day, month, year] = dateMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function formatTimestampValue(value: string): string {
    const normalizedValue = value.replace('T', ' ');
    const timestampMatch = normalizedValue.match(
        /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/
    );

    if (!timestampMatch) {
        return normalizedValue;
    }

    const [, day, month, year, hour = '00', minute = '00', second = '00'] = timestampMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

function truncateNumeric(value: string, scale: number, decimalDelimiter: string): string {
    if (!value || scale < 0) {
        return value;
    }

    const normalized = normalizeImportNumberForDb(value, decimalDelimiter, scale);
    if (normalized !== null) {
        return normalized;
    }

    const parts = value.split(decimalDelimiter);
    if (parts.length !== 2) {
        return value;
    }

    const [integerPart, decimalPart] = parts;
    if (decimalPart.length <= scale) {
        return value;
    }

    return `${integerPart}${decimalDelimiter}${decimalPart.slice(0, scale)}`;
}

const MSSQL_NUMERIC_BASE_TYPES = new Set(['NUMERIC', 'DECIMAL', 'BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'REAL', 'FLOAT', 'MONEY', 'SMALLMONEY']);

function normalizeValueForType(value: string, dataType: string, decimalDelimiter: string): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const baseType = getBaseDataType(dataType);

    // Lone dash: 0 in numeric columns, the dash itself in text columns.
    if (isDashZeroImportCell(trimmed)) {
        return MSSQL_NUMERIC_BASE_TYPES.has(baseType) ? '0' : trimmed;
    }

    if (baseType === 'DATE') {
        return formatDateValue(trimmed);
    }

    if (baseType === 'DATETIME' || baseType === 'DATETIME2' || baseType === 'TIMESTAMP') {
        return formatTimestampValue(trimmed);
    }

    if (MSSQL_NUMERIC_BASE_TYPES.has(baseType)) {
        const declaredScale = getNumericScale(dataType) ?? 0;
        const normalized = normalizeImportNumberForDb(
            trimmed,
            decimalDelimiter,
            (baseType === 'NUMERIC' || baseType === 'DECIMAL') && declaredScale > 0
                ? declaredScale
                : undefined
        );
        if (normalized !== null) {
            return normalized;
        }
        let fallback = trimmed.replace(/\s/g, '');
        if ((baseType === 'NUMERIC' || baseType === 'DECIMAL') && declaredScale > 0) {
            fallback = truncateNumeric(fallback, declaredScale, decimalDelimiter);
        }
        if (decimalDelimiter === ',') {
            fallback = fallback.replace(',', '.');
        }
        return fallback;
    }

    return trimmed;
}

function toSqlLiteral(value: string | null, dataType: string): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(dataType);
    if (
        ['BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'NUMERIC', 'DECIMAL', 'REAL', 'FLOAT', 'MONEY', 'SMALLMONEY', 'BIT'].includes(
            baseType
        )
    ) {
        return value;
    }

    return `N'${escapeSqlLiteral(value)}'`;
}

export function buildCreateTableSql(target: MsSqlTargetTable, columns: ImportColumnDescriptor[]): string {
    const columnDefinitions = columns.map(
        (column) => `    ${formatIdentifier(column.columnName)} ${mapImportTypeToMsSqlType(column.dataType)}`
    );

    return `CREATE TABLE ${target.qualifiedName} (\n${columnDefinitions.join(',\n')}\n)`;
}

export function buildInsertSql(
    target: MsSqlTargetTable,
    columns: ImportColumnDescriptor[],
    rows: string[][],
    decimalDelimiter: string
): string {
    const columnList = columns.map((column) => formatIdentifier(column.columnName)).join(', ');
    const valueRows = rows.map((row) => {
        const literals = columns.map((column) => {
            const rawValue = row[column.sourceIndex] ?? '';
            const normalized = normalizeValueForType(rawValue, column.dataType, decimalDelimiter);
            return toSqlLiteral(normalized, column.dataType);
        });
        return `(${literals.join(', ')})`;
    });

    return `INSERT INTO ${target.qualifiedName} (${columnList}) VALUES\n${valueRows.join(',\n')}`;
}

async function executeStatement(connection: DatabaseConnection, sql: string, timeoutSeconds: number = 1800): Promise<void> {
    const command = connection.createCommand(sql);
    command.commandTimeout = timeoutSeconds;
    await command.execute();
}

async function insertRows(
    connection: DatabaseConnection,
    target: MsSqlTargetTable,
    columns: ImportColumnDescriptor[],
    rows: Iterable<string[]> | AsyncIterable<string[]>,
    decimalDelimiter: string,
    totalRows: number,
    progressCallback?: ProgressCallback,
    isCancelled?: ImportCancellationCheck
): Promise<number> {
    let insertedRows = 0;
    let batch: string[][] = [];

    for await (const row of rows) {
        throwIfImportCancelled(isCancelled);
        batch.push(row);
        if (batch.length < INSERT_BATCH_SIZE) {
            continue;
        }

        const insertSql = buildInsertSql(target, columns, batch, decimalDelimiter);
        throwIfImportCancelled(isCancelled);
        await executeStatement(connection, insertSql);
        insertedRows += batch.length;
        batch = [];
        progressCallback?.(
            `Inserted ${insertedRows.toLocaleString()}/${totalRows.toLocaleString()} rows`,
            undefined,
            false
        );
    }

    if (batch.length > 0) {
        const insertSql = buildInsertSql(target, columns, batch, decimalDelimiter);
        throwIfImportCancelled(isCancelled);
        await executeStatement(connection, insertSql);
        insertedRows += batch.length;
        progressCallback?.(
            `Inserted ${insertedRows.toLocaleString()}/${totalRows.toLocaleString()} rows`,
            undefined,
            false
        );
    }

    return insertedRows;
}

export async function importDataToMsSql(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    _timeout?: number,
    columnOptions?: ImportColumnOptions,
    isCancelled?: ImportCancellationCheck
): Promise<ImportResult> {
    const startTime = Date.now();
    let connection: DatabaseConnection | null = null;
    let createdTargetTable = false;
    let targetForCleanup: MsSqlTargetTable | undefined;

    try {
        throwIfImportCancelled(isCancelled);
        if (!filePath || !targetTable) {
            throw new Error('Source file path and target table are required.');
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`Source file does not exist: ${filePath}`);
        }

        progressCallback?.('Analyzing source file...');
        const importer = createTabularDataImporter(filePath, targetTable, {
            kind: 'mssql',
            hasHeaders: columnOptions?.hasHeaders,
            delimiter: columnOptions?.delimiter,
            skipRows: columnOptions?.skipRows,
            encoding: columnOptions?.encoding,
            isCancelled,
        });
        if (columnOptions?.sheetName?.trim()) {
            importer.setSelectedSheet(columnOptions.sheetName);
        }
        await importer.analyzeDataTypes(progressCallback);
        importer.applyColumnOptions(columnOptions);

        const target = parseMsSqlTargetTable(targetTable, connectionDetails);
        targetForCleanup = target;
        const columns = importer.getEffectiveColumnDescriptors();
        if (columns.length === 0) {
            throw new Error('No columns selected for import.');
        }

        const totalRows = importer.getRowsCount();
        if (totalRows === 0) {
            throw new Error('No data rows found in source file.');
        }

        progressCallback?.(`Preparing MS SQL Server import for ${totalRows.toLocaleString()} rows...`);
        connection = await createConnectedDatabaseConnectionFromDetails({
            ...connectionDetails,
            dbType: 'mssql'
        });

        throwIfImportCancelled(isCancelled);
        if (!columnOptions?.appendToExistingTable) {
            const createTableSql = buildCreateTableSql(target, columns);
            progressCallback?.(`Creating target table ${target.displayName}...`);
            await executeStatement(connection, createTableSql, 3600);
            createdTargetTable = true;
        }

        const insertedRows = await insertRows(
            connection,
            target,
            columns,
            importer.iterateRows(),
            importer.getDecimalDelimiter(),
            totalRows,
            progressCallback,
            isCancelled
        );

        const processingTime = (Date.now() - startTime) / 1000;
        return {
            success: true,
            message: `Successfully imported ${insertedRows.toLocaleString()} rows to ${target.displayName}`,
            details: {
                sourceFile: filePath,
                targetTable: target.displayName,
                fileSize: fs.statSync(filePath).size,
                format: path.extname(filePath).replace('.', '').toUpperCase() || 'UNKNOWN',
                rowsProcessed: totalRows,
                rowsInserted: insertedRows,
                processingTime: `${processingTime.toFixed(2)} seconds`,
                columns: columns.length,
                detectedDelimiter: importer.getCsvDelimiter(),
                warnings: (() => {
                    const warning = buildWidthMismatchWarning(importer.getWidthMismatchCount());
                    return warning ? [warning] : undefined;
                })()
            }
        };
    } catch (error: unknown) {
        if (connection && createdTargetTable && targetForCleanup) {
            try {
                await executeStatement(connection, `DROP TABLE ${targetForCleanup.qualifiedName}`, 3600);
            } catch {
                // Surface the original import error while best-effort cleaning up.
            }
        }
        return {
            success: false,
            message: error instanceof Error ? error.message : String(error)
        };
    } finally {
        if (connection) {
            await connection.close();
        }
    }
}

export async function importClipboardDataToMsSql(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    _formatPreference?: string | null,
    options?: unknown,
    progressCallback?: ProgressCallback,
    isCancelled?: ImportCancellationCheck
): Promise<ImportResult> {
    const columnOptions = options && typeof options === 'object'
        ? options as ImportColumnOptions
        : undefined;
    const startTime = Date.now();
    let connection: DatabaseConnection | null = null;
    let createdTargetTable = false;
    let targetForCleanup: MsSqlTargetTable | undefined;

    try {
        throwIfImportCancelled(isCancelled);
        if (!targetTable) {
            throw new Error('Target table name is required.');
        }

        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData(progressCallback);
        const headers = normalizeAndDeduplicateHeaders(analyzer.getHeaders());
        const dataTypes = analyzer.getDataTypes().map((typeChooser) => typeChooser.currentType.toString());
        const rowsIterator = analyzer.dataRowIterator();
        const totalRows = analyzer.getRowCount();

        if (headers.length === 0) {
            throw new Error('No columns found in clipboard data.');
        }
        if (totalRows === 0) {
            throw new Error('No rows found in clipboard data.');
        }

        const columns: ImportColumnDescriptor[] = headers.map((columnName, index) => ({
            sourceIndex: index,
            columnName,
            dataType: dataTypes[index] || 'NVARCHAR(255)'
        }));

        const target = parseMsSqlTargetTable(targetTable, connectionDetails);
        targetForCleanup = target;
        connection = await createConnectedDatabaseConnectionFromDetails({
            ...connectionDetails,
            dbType: 'mssql'
        });

        throwIfImportCancelled(isCancelled);
        if (!columnOptions?.appendToExistingTable) {
            progressCallback?.(`Creating target table ${target.displayName}...`);
            await executeStatement(connection, buildCreateTableSql(target, columns), 3600);
            createdTargetTable = true;
        }

        const insertedRows = await insertRows(
            connection,
            target,
            columns,
            rowsIterator,
            analyzer.getDecimalDelimiter(),
            totalRows,
            progressCallback,
            isCancelled
        );

        const processingTime = (Date.now() - startTime) / 1000;
        return {
            success: true,
            message: `Successfully imported ${insertedRows.toLocaleString()} rows to ${target.displayName}`,
            details: {
                targetTable: target.displayName,
                format: 'CLIPBOARD',
                rowsProcessed: totalRows,
                rowsInserted: insertedRows,
                processingTime: `${processingTime.toFixed(2)} seconds`,
                columns: columns.length
            }
        };
    } catch (error: unknown) {
        if (connection && createdTargetTable && targetForCleanup) {
            try {
                await executeStatement(connection, `DROP TABLE ${targetForCleanup.qualifiedName}`, 3600);
            } catch {
                // Surface the original import error while best-effort cleaning up.
            }
        }
        return {
            success: false,
            message: error instanceof Error ? error.message : String(error)
        };
    } finally {
        if (connection) {
            await connection.close();
        }
    }
}
