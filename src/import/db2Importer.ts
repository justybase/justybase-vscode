import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseConnection } from '../contracts/database';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import type { ConnectionDetails } from '../types';
import { ClipboardDataProcessor } from './clipboardImporter';
import {
    ImportColumnDescriptor,
    ImportColumnOptions,
    ImportResult,
    ProgressCallback
} from './dataImporter';
import { normalizeAndDeduplicateHeaders } from './importHeaderUtils';
import { createTabularDataImporter } from './tabularDataImporter';

const DB2_MAX_VARCHAR_LENGTH = 32672;
const DB2_MAX_CHAR_LENGTH = 254;
const INSERT_BATCH_SIZE = 100;
const DB2_RESERVED_KEYWORDS = new Set([
    'ADD', 'ALTER', 'AND', 'AS', 'BY', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CURRENT', 'DATE',
    'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'EXISTS', 'FOREIGN', 'FROM', 'FULL', 'GROUP',
    'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'PROCEDURE', 'REFERENCES', 'RIGHT', 'SCHEMA',
    'SELECT', 'SET', 'TABLE', 'TIME', 'TIMESTAMP', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'VALUES', 'VIEW',
    'WHERE'
]);

interface Db2TargetTable {
    providedDatabase?: string;
    schema?: string;
    table: string;
    qualifiedName: string;
    displayName: string;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function formatIdentifier(identifier: string): string {
    if (/^[A-Z_][A-Z0-9_]*$/.test(identifier) && !DB2_RESERVED_KEYWORDS.has(identifier.toUpperCase())) {
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

export function mapImportTypeToDb2Type(typeName: string): string {
    const normalized = normalizeDataType(typeName);
    const baseType = getBaseDataType(normalized);

    if (baseType === 'DATETIME') {
        return 'TIMESTAMP';
    }

    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const numericMatch = normalized.match(/^(NUMERIC|DECIMAL)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (numericMatch) {
            return `DECIMAL(${numericMatch[2]},${numericMatch[3]})`;
        }
        return 'DECIMAL(31,10)';
    }

    if (baseType === 'NVARCHAR' || baseType === 'VARCHAR') {
        const lengthMatch = normalized.match(/^(N?VARCHAR)\(\s*(\d+)\s*\)$/);
        const parsedLength = lengthMatch ? Number(lengthMatch[2]) : 255;
        const boundedLength = Math.max(1, Math.min(parsedLength, DB2_MAX_VARCHAR_LENGTH));
        return `VARCHAR(${boundedLength})`;
    }

    if (baseType === 'CHAR') {
        const lengthMatch = normalized.match(/^CHAR\(\s*(\d+)\s*\)$/);
        const parsedLength = lengthMatch ? Number(lengthMatch[1]) : 1;
        const boundedLength = Math.max(1, Math.min(parsedLength, DB2_MAX_CHAR_LENGTH));
        return `CHAR(${boundedLength})`;
    }

    return normalized;
}

export function parseDb2TargetTable(targetTable: string, connectionDetails: ConnectionDetails): Db2TargetTable {
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
            `DB2 import runs against active database "${activeDatabase}". ` +
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

function normalizeValueForType(value: string, dataType: string, decimalDelimiter: string): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const baseType = getBaseDataType(dataType);

    if (baseType === 'DATE') {
        return formatDateValue(trimmed);
    }

    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return formatTimestampValue(trimmed);
    }

    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        const declaredScale = getNumericScale(dataType) ?? 0;
        let normalized = trimmed;
        if (declaredScale > 0) {
            normalized = truncateNumeric(normalized, declaredScale, decimalDelimiter);
        }
        if (decimalDelimiter === ',') {
            normalized = normalized.replace(',', '.');
        }
        return normalized;
    }

    return trimmed;
}

function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

function toSqlLiteral(value: string | null, dataType: string): string {
    if (value === null) {
        return 'NULL';
    }

    const baseType = getBaseDataType(dataType);
    if (['BIGINT', 'INTEGER', 'INT', 'SMALLINT', 'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE', 'FLOAT', 'DECFLOAT'].includes(baseType)) {
        return value;
    }

    return `'${escapeSqlLiteral(value)}'`;
}

export function buildCreateTableSql(target: Db2TargetTable, columns: ImportColumnDescriptor[]): string {
    const columnDefinitions = columns.map(column =>
        `    ${formatIdentifier(column.columnName)} ${mapImportTypeToDb2Type(column.dataType)}`
    );

    return `CREATE TABLE ${target.qualifiedName} (\n${columnDefinitions.join(',\n')}\n)`;
}

export function buildInsertSql(
    target: Db2TargetTable,
    columns: ImportColumnDescriptor[],
    rows: string[][],
    decimalDelimiter: string
): string {
    const columnList = columns.map(column => formatIdentifier(column.columnName)).join(', ');
    const valueRows = rows.map(row => {
        const literals = columns.map(column => {
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
    target: Db2TargetTable,
    columns: ImportColumnDescriptor[],
    rows: Iterable<string[]>,
    decimalDelimiter: string,
    totalRows: number,
    progressCallback?: ProgressCallback
): Promise<number> {
    let insertedRows = 0;
    let batch: string[][] = [];

    for (const row of rows) {
        batch.push(row);
        if (batch.length < INSERT_BATCH_SIZE) {
            continue;
        }

        const insertSql = buildInsertSql(target, columns, batch, decimalDelimiter);
        await executeStatement(connection, insertSql);
        insertedRows += batch.length;
        batch = [];
        progressCallback?.(`Inserted ${insertedRows.toLocaleString()}/${totalRows.toLocaleString()} rows`, undefined, false);
    }

    if (batch.length > 0) {
        const insertSql = buildInsertSql(target, columns, batch, decimalDelimiter);
        await executeStatement(connection, insertSql);
        insertedRows += batch.length;
        progressCallback?.(`Inserted ${insertedRows.toLocaleString()}/${totalRows.toLocaleString()} rows`, undefined, false);
    }

    return insertedRows;
}

export async function importDataToDb2(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    _timeout?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    const startTime = Date.now();
    let connection: DatabaseConnection | null = null;

    try {
        if (!filePath || !targetTable) {
            throw new Error('Source file path and target table are required.');
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`Source file does not exist: ${filePath}`);
        }

        progressCallback?.('Analyzing source file...');
        const importer = createTabularDataImporter(filePath, targetTable, { kind: 'db2' });
        await importer.analyzeDataTypes(progressCallback);
        importer.applyColumnOptions(columnOptions);

        const target = parseDb2TargetTable(targetTable, connectionDetails);
        const columns = importer.getEffectiveColumnDescriptors();
        if (columns.length === 0) {
            throw new Error('No columns selected for import.');
        }

        const rows = await importer.getAllRows();
        if (rows.length === 0) {
            throw new Error('No data rows found in source file.');
        }

        progressCallback?.(`Preparing Db2 import for ${rows.length.toLocaleString()} rows...`);
        connection = await createConnectedDatabaseConnectionFromDetails({
            ...connectionDetails,
            dbType: 'db2'
        });

        const createTableSql = buildCreateTableSql(target, columns);
        progressCallback?.(`Creating target table ${target.displayName}...`);
        await executeStatement(connection, createTableSql, 3600);

        const insertedRows = await insertRows(
            connection,
            target,
            columns,
            rows,
            importer.getDecimalDelimiter(),
            rows.length,
            progressCallback
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
                rowsProcessed: rows.length,
                rowsInserted: insertedRows,
                processingTime: `${processingTime.toFixed(2)} seconds`,
                columns: columns.length,
                detectedDelimiter: importer.getCsvDelimiter()
            }
        };
    } catch (error: unknown) {
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

export async function importClipboardDataToDb2(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    _formatPreference?: string | null,
    _options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    const startTime = Date.now();
    let connection: DatabaseConnection | null = null;

    try {
        if (!targetTable) {
            throw new Error('Target table name is required.');
        }

        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData(progressCallback);
        const headers = normalizeAndDeduplicateHeaders(analyzer.getHeaders());
        const dataTypes = analyzer.getDataTypes().map(typeChooser => typeChooser.currentType.toString());
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

        const target = parseDb2TargetTable(targetTable, connectionDetails);
        connection = await createConnectedDatabaseConnectionFromDetails({
            ...connectionDetails,
            dbType: 'db2'
        });

        progressCallback?.(`Creating target table ${target.displayName}...`);
        await executeStatement(connection, buildCreateTableSql(target, columns), 3600);

        const insertedRows = await insertRows(
            connection,
            target,
            columns,
            rowsIterator,
            analyzer.getDecimalDelimiter(),
            totalRows,
            progressCallback
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
