import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseConnection, DatabaseKind } from '../contracts/database';
import { getDatabaseDialectTraits } from '../core/dialectTraits';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import type { ConnectionDetails } from '../types';
import { formatIdentifierForSql } from '../utils/identifierUtils';
import { ClipboardDataProcessor } from './clipboardImporter';
import {
    getBaseDataType,
    getNumericScale,
    ImportColumnDescriptor,
    ImportColumnOptions,
    ImportResult,
    ProgressCallback,
    normalizeDataType
} from './dataImporter';
import { normalizeAndDeduplicateHeaders } from './importHeaderUtils';
import { createTabularDataImporter } from './tabularDataImporter';

const SUPPORTED_FILE_FORMATS = ['.csv', '.txt', '.xlsx', '.xlsb'];

export interface BatchImportTargetTable {
    providedDatabase?: string;
    schema?: string;
    table: string;
    qualifiedName: string;
    displayName: string;
}

export interface PreparedImportColumnDescriptor extends ImportColumnDescriptor {
    sourceDataType: string;
    targetDataType: string;
}

export interface BatchImportDialectConfig {
    kind: DatabaseKind;
    label: string;
    insertBatchSize: number;
    inferBoolean?: boolean;
    cleanupCreatedTargetOnFailure?: boolean;
    mapImportType(typeName: string): string;
    parseTargetTable(targetTable: string, connectionDetails: ConnectionDetails): BatchImportTargetTable;
    toSqlLiteral(value: string | null, column: PreparedImportColumnDescriptor, decimalDelimiter: string): string;
    beginTransactionSql?: string;
    commitTransactionSql?: string;
    rollbackTransactionSql?: string;
    buildInsertSql?(
        target: BatchImportTargetTable,
        columns: PreparedImportColumnDescriptor[],
        rows: string[][],
        decimalDelimiter: string
    ): string;
    buildDropTableSql?(target: BatchImportTargetTable): string;
}

interface ImportExecutionInput {
    targetTable: string;
    connectionDetails: ConnectionDetails;
    columns: ImportColumnDescriptor[];
    rows: Iterable<string[]>;
    totalRows: number;
    decimalDelimiter: string;
    progressCallback?: ProgressCallback;
    sourceFile?: string;
    fileSize?: number;
    format: string;
    detectedDelimiter?: string;
}

export function composeQualifiedImportTargetDisplayName(
    databaseName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
    kind: DatabaseKind,
): string {
    const traits = getDatabaseDialectTraits(kind).qualification;

    if (traits.twoPartNameStyle === 'database-object') {
        const container =
            traits.twoPartContainerPreference === 'schema-over-database'
                ? schemaName || databaseName
                : databaseName || schemaName;
        return container ? `${container}.${tableName}` : tableName;
    }

    if (databaseName && schemaName && traits.supportsThreePartName) {
        return `${databaseName}.${schemaName}.${tableName}`;
    }
    if (schemaName) {
        return `${schemaName}.${tableName}`;
    }
    if (databaseName) {
        if (traits.databaseOnlyReferenceStyle === 'double-dot') {
            return `${databaseName}..${tableName}`;
        }
        if (traits.databaseOnlyReferenceStyle === 'single-dot') {
            return `${databaseName}.${tableName}`;
        }
    }

    return tableName;
}

function formatQualifiedTargetTableName(
    databaseName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
    kind: DatabaseKind
): string {
    const traits = getDatabaseDialectTraits(kind).qualification;
    const formattedTable = formatIdentifierForSql(tableName, kind);
    const formattedDatabase = databaseName ? formatIdentifierForSql(databaseName, kind) : undefined;
    const formattedSchema = schemaName ? formatIdentifierForSql(schemaName, kind) : undefined;

    if (traits.twoPartNameStyle === 'database-object') {
        const container = traits.twoPartContainerPreference === 'schema-over-database'
            ? formattedSchema || formattedDatabase
            : formattedDatabase || formattedSchema;
        return container ? `${container}.${formattedTable}` : formattedTable;
    }

    if (formattedDatabase && formattedSchema && traits.supportsThreePartName) {
        return `${formattedDatabase}.${formattedSchema}.${formattedTable}`;
    }
    if (formattedSchema) {
        return `${formattedSchema}.${formattedTable}`;
    }
    if (formattedDatabase) {
        if (traits.databaseOnlyReferenceStyle === 'double-dot') {
            return `${formattedDatabase}..${formattedTable}`;
        }
        if (traits.databaseOnlyReferenceStyle === 'single-dot') {
            return `${formattedDatabase}.${formattedTable}`;
        }
    }

    return formattedTable;
}

export function parseImportTargetTable(
    targetTable: string,
    connectionDetails: ConnectionDetails,
    kind: DatabaseKind,
    options?: {
        supportsThreePartName?: boolean;
        enforceActiveDatabaseMatch?: boolean;
    }
): BatchImportTargetTable {
    const parts = targetTable
        .split('.')
        .map(part => part.trim())
        .filter(part => part.length > 0);

    const traits = getDatabaseDialectTraits(kind).qualification;
    const supportsThreePartName = options?.supportsThreePartName ?? traits.supportsThreePartName;

    if (parts.length === 0 || parts.length > 3) {
        throw new Error('Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.');
    }

    if (parts.length === 3 && !supportsThreePartName) {
        throw new Error(`Three-part target names are not supported for ${kind}.`);
    }

    if (parts.length === 1) {
        const [table] = parts;
        return {
            table,
            qualifiedName: formatQualifiedTargetTableName(undefined, undefined, table, kind),
            displayName: table
        };
    }

    if (parts.length === 2) {
        const [first, second] = parts;
        if (traits.twoPartNameStyle === 'database-object') {
            return {
                providedDatabase: first,
                table: second,
                qualifiedName: formatQualifiedTargetTableName(first, undefined, second, kind),
                displayName: `${first}.${second}`
            };
        }

        return {
            schema: first,
            table: second,
            qualifiedName: formatQualifiedTargetTableName(undefined, first, second, kind),
            displayName: `${first}.${second}`
        };
    }

    const [providedDatabase, schema, table] = parts;
    const activeDatabase = connectionDetails.database?.trim();
    if (
        options?.enforceActiveDatabaseMatch
        && activeDatabase
        && providedDatabase.toUpperCase() !== activeDatabase.toUpperCase()
    ) {
        throw new Error(
            `${kind} import runs against active database "${activeDatabase}". ` +
            `Provided database "${providedDatabase}" does not match the active connection.`
        );
    }

    return {
        providedDatabase,
        schema,
        table,
        qualifiedName: formatQualifiedTargetTableName(providedDatabase, schema, table, kind),
        displayName: `${providedDatabase}.${schema}.${table}`
    };
}

export function normalizeDateValue(value: string): string {
    const trimmed = value.trim();
    const isoMatch = trimmed.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    const localMatch = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!localMatch) {
        return trimmed;
    }

    const [, day, month, year] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

export function normalizeTimestampValue(value: string): string {
    const normalizedValue = value.trim().replace('T', ' ');
    const isoMatch = normalizedValue.match(
        /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/
    );
    if (isoMatch) {
        const [, year, month, day, hour = '00', minute = '00', second = '00'] = isoMatch;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
    }

    const localMatch = normalizedValue.match(
        /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/
    );
    if (!localMatch) {
        return normalizedValue;
    }

    const [, day, month, year, hour = '00', minute = '00', second = '00'] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

export function normalizeTimestampWithTimeZoneValue(value: string): string {
    const normalizedValue = value.trim().replace('T', ' ');
    const match = normalizedValue.match(
        /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i,
    );
    if (!match) {
        return normalizedValue;
    }

    const [, year, month, day, hour = '00', minute = '00', second = '00', fraction, rawOffset] = match;
    const offset = rawOffset.toUpperCase() === 'Z'
        ? '+00:00'
        : rawOffset.includes(':') ? rawOffset : `${rawOffset.slice(0, 3)}:${rawOffset.slice(3)}`;
    const fractionPart = fraction ? `.${fraction}` : '';
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}${fractionPart} ${offset}`;
}

export function truncateNumeric(value: string, scale: number, decimalDelimiter: string): string {
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

function normalizeBooleanValue(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (['true', 't', 'yes', 'y', '1'].includes(normalized)) {
        return '1';
    }
    if (['false', 'f', 'no', 'n', '0'].includes(normalized)) {
        return '0';
    }
    return value.trim();
}

export function escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

export function normalizeImportedLiteralValue(
    value: string,
    sourceType: string,
    targetType: string,
    decimalDelimiter: string
): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const normalizedSourceType = getBaseDataType(sourceType);
    const normalizedTargetType = getBaseDataType(targetType);
    const sourceTypeWithZone = normalizeDataType(sourceType);
    const targetTypeWithZone = normalizeDataType(targetType);

    if (
        sourceTypeWithZone.includes('TIMESTAMP WITH TIME ZONE')
        || sourceTypeWithZone.includes('TIMESTAMP WITH LOCAL TIME ZONE')
        || targetTypeWithZone.includes('TIMESTAMP WITH TIME ZONE')
        || targetTypeWithZone.includes('TIMESTAMP WITH LOCAL TIME ZONE')
    ) {
        return normalizeTimestampWithTimeZoneValue(trimmed);
    }

    if (normalizedSourceType === 'BOOLEAN' || normalizedTargetType === 'BOOLEAN' || normalizedTargetType === 'BIT') {
        return normalizeBooleanValue(trimmed);
    }

    if (normalizedSourceType === 'DATE' || normalizedTargetType === 'DATE') {
        return normalizeDateValue(trimmed);
    }

    if (
        normalizedSourceType === 'DATETIME'
        || normalizedSourceType === 'TIMESTAMP'
        || normalizedTargetType === 'DATETIME'
        || normalizedTargetType === 'DATETIME2'
        || normalizedTargetType === 'TIMESTAMP'
    ) {
        return normalizeTimestampValue(trimmed);
    }

    if (
        normalizedSourceType === 'NUMERIC'
        || normalizedSourceType === 'DECIMAL'
        || normalizedTargetType === 'NUMERIC'
        || normalizedTargetType === 'DECIMAL'
        || normalizedTargetType === 'NUMBER'
        || normalizedTargetType === 'DOUBLE'
        || normalizedTargetType === 'REAL'
        || normalizedTargetType === 'FLOAT'
    ) {
        const scale = getNumericScale(targetType) ?? 0;
        let normalized = trimmed;
        if (scale > 0) {
            normalized = truncateNumeric(normalized, scale, decimalDelimiter);
        }
        if (decimalDelimiter === ',') {
            normalized = normalized.replace(',', '.');
        }
        return normalized;
    }

    return trimmed;
}

function buildPreparedColumns(
    columns: ImportColumnDescriptor[],
    config: BatchImportDialectConfig
): PreparedImportColumnDescriptor[] {
    return columns.map(column => ({
        ...column,
        sourceDataType: column.dataType,
        targetDataType: config.mapImportType(column.dataType)
    }));
}

function buildCreateTableSql(target: BatchImportTargetTable, columns: PreparedImportColumnDescriptor[], kind: DatabaseKind): string {
    const columnDefinitions = columns.map(column =>
        `    ${formatIdentifierForSql(column.columnName, kind)} ${column.targetDataType}`
    );

    return `CREATE TABLE ${target.qualifiedName} (\n${columnDefinitions.join(',\n')}\n)`;
}

function buildDefaultInsertSql(
    config: BatchImportDialectConfig,
    target: BatchImportTargetTable,
    columns: PreparedImportColumnDescriptor[],
    rows: string[][],
    decimalDelimiter: string
): string {
    const columnList = columns.map(column => formatIdentifierForSql(column.columnName, config.kind)).join(', ');
    const valueRows = rows.map(row => {
        const literals = columns.map(column =>
            config.toSqlLiteral(
                normalizeImportedLiteralValue(
                    row[column.sourceIndex] ?? '',
                    column.sourceDataType,
                    column.targetDataType,
                    decimalDelimiter
                ),
                column,
                decimalDelimiter
            )
        );
        return `(${literals.join(', ')})`;
    });

    return `INSERT INTO ${target.qualifiedName} (${columnList}) VALUES\n${valueRows.join(',\n')}`;
}

export function buildBatchCreateTablePreview(
    config: BatchImportDialectConfig,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    columns: ImportColumnDescriptor[]
): string {
    const target = config.parseTargetTable(targetTable, connectionDetails);
    const preparedColumns = buildPreparedColumns(columns, config);
    return buildCreateTableSql(target, preparedColumns, config.kind);
}

export function buildBatchLoadPreview(
    config: BatchImportDialectConfig,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    columns: ImportColumnDescriptor[],
    previewRows: string[][],
    decimalDelimiter: string
): string | undefined {
    if (previewRows.length === 0) {
        return undefined;
    }

    const target = config.parseTargetTable(targetTable, connectionDetails);
    const preparedColumns = buildPreparedColumns(columns, config);
    const sampleRows = previewRows.slice(0, Math.min(previewRows.length, config.insertBatchSize, 3));
    const previewSql = config.buildInsertSql
        ? config.buildInsertSql(target, preparedColumns, sampleRows, decimalDelimiter)
        : buildDefaultInsertSql(config, target, preparedColumns, sampleRows, decimalDelimiter);

    return `${previewSql}\n-- Preview shows sample rows only. Execution inserts all selected rows in batches.`;
}

export async function executeStatement(connection: DatabaseConnection, sql: string, timeoutSeconds: number = 1800): Promise<void> {
    const command = connection.createCommand(sql);
    command.commandTimeout = timeoutSeconds;
    await command.execute();
}

async function insertRowsInBatches(
    connection: DatabaseConnection,
    config: BatchImportDialectConfig,
    target: BatchImportTargetTable,
    columns: PreparedImportColumnDescriptor[],
    rows: Iterable<string[]>,
    decimalDelimiter: string,
    totalRows: number,
    progressCallback?: ProgressCallback
): Promise<number> {
    let insertedRows = 0;
    let batch: string[][] = [];

    for (const row of rows) {
        batch.push(row);
        if (batch.length < config.insertBatchSize) {
            continue;
        }

        const insertSql = config.buildInsertSql
            ? config.buildInsertSql(target, columns, batch, decimalDelimiter)
            : buildDefaultInsertSql(config, target, columns, batch, decimalDelimiter);
        await executeStatement(connection, insertSql);
        insertedRows += batch.length;
        batch = [];
        progressCallback?.(`Inserted ${insertedRows.toLocaleString()}/${totalRows.toLocaleString()} rows`, undefined, false);
    }

    if (batch.length > 0) {
        const insertSql = config.buildInsertSql
            ? config.buildInsertSql(target, columns, batch, decimalDelimiter)
            : buildDefaultInsertSql(config, target, columns, batch, decimalDelimiter);
        await executeStatement(connection, insertSql);
        insertedRows += batch.length;
        progressCallback?.(`Inserted ${insertedRows.toLocaleString()}/${totalRows.toLocaleString()} rows`, undefined, false);
    }

    return insertedRows;
}

async function executeBatchImport(
    config: BatchImportDialectConfig,
    input: ImportExecutionInput
): Promise<ImportResult> {
    const startTime = Date.now();
    let connection: DatabaseConnection | null = null;
    let createdTargetTable = false;
    let targetForCleanup: BatchImportTargetTable | undefined;
    const warnings: string[] = [];

    try {
        const target = config.parseTargetTable(input.targetTable, input.connectionDetails);
        targetForCleanup = target;
        const columns = buildPreparedColumns(input.columns, config);

        if (columns.length === 0) {
            throw new Error('No columns selected for import.');
        }
        if (input.totalRows === 0) {
            throw new Error('No data rows found in source.');
        }

        input.progressCallback?.(`Preparing ${config.label} import for ${input.totalRows.toLocaleString()} rows...`);
        connection = await createConnectedDatabaseConnectionFromDetails({
            ...input.connectionDetails,
            dbType: config.kind
        });

        if (config.beginTransactionSql) {
            await executeStatement(connection, config.beginTransactionSql);
        }

        input.progressCallback?.(`Creating target table ${target.displayName}...`);
        await executeStatement(connection, buildCreateTableSql(target, columns, config.kind), 3600);
        createdTargetTable = true;

        const insertedRows = await insertRowsInBatches(
            connection,
            config,
            target,
            columns,
            input.rows,
            input.decimalDelimiter,
            input.totalRows,
            input.progressCallback
        );

        if (config.commitTransactionSql) {
            await executeStatement(connection, config.commitTransactionSql);
        }

        const processingTime = (Date.now() - startTime) / 1000;
        return {
            success: true,
            message: `Successfully imported ${insertedRows.toLocaleString()} rows to ${target.displayName}`,
            details: {
                sourceFile: input.sourceFile,
                targetTable: target.displayName,
                fileSize: input.fileSize,
                format: input.format,
                rowsProcessed: input.totalRows,
                rowsInserted: insertedRows,
                processingTime: `${processingTime.toFixed(2)} seconds`,
                columns: columns.length,
                detectedDelimiter: input.detectedDelimiter,
                warnings: warnings.length > 0 ? warnings : undefined,
            }
        };
    } catch (error: unknown) {
        if (connection && config.rollbackTransactionSql) {
            try {
                await executeStatement(connection, config.rollbackTransactionSql);
            } catch {
                // Surface the original import error while best-effort rolling back.
            }
        }

        if (
            connection
            && createdTargetTable
            && config.cleanupCreatedTargetOnFailure
            && config.buildDropTableSql
            && targetForCleanup
        ) {
            try {
                await executeStatement(connection, config.buildDropTableSql(targetForCleanup), 3600);
            } catch (cleanupError: unknown) {
                warnings.push(
                    `Failed to remove the newly created target table ${targetForCleanup.displayName}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                );
            }
        }

        return {
            success: false,
            message: error instanceof Error ? error.message : String(error),
            details: {
                sourceFile: input.sourceFile,
                targetTable: targetForCleanup?.displayName,
                fileSize: input.fileSize,
                format: input.format,
                rowsProcessed: input.totalRows,
                warnings: warnings.length > 0 ? warnings : undefined,
            },
        };
    } finally {
        if (connection) {
            await connection.close();
        }
    }
}

export async function importDataWithBatching(
    config: BatchImportDialectConfig,
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    _timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    if (!filePath || !targetTable) {
        return {
            success: false,
            message: 'Source file path and target table are required.'
        };
    }
    if (!fs.existsSync(filePath)) {
        return {
            success: false,
            message: `Source file does not exist: ${filePath}`
        };
    }

    const fileExt = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_FILE_FORMATS.includes(fileExt)) {
        return {
            success: false,
            message: `Unsupported file format: ${fileExt}. Supported: ${SUPPORTED_FILE_FORMATS.join(', ')}`
        };
    }

    progressCallback?.('Analyzing source file...');
    const importer = createTabularDataImporter(filePath, targetTable, {
        kind: config.kind,
        inferBoolean: config.inferBoolean,
    });
    await importer.analyzeDataTypes(progressCallback);
    importer.applyColumnOptions(columnOptions);

    const rows = await importer.getAllRows();
    return executeBatchImport(config, {
        targetTable,
        connectionDetails,
        columns: importer.getEffectiveColumnDescriptors(),
        rows,
        totalRows: rows.length,
        decimalDelimiter: importer.getDecimalDelimiter(),
        progressCallback,
        sourceFile: filePath,
        fileSize: fs.statSync(filePath).size,
        format: path.extname(filePath).replace('.', '').toUpperCase() || 'UNKNOWN',
        detectedDelimiter: importer.getCsvDelimiter()
    });
}

export async function importClipboardWithBatching(
    config: BatchImportDialectConfig,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    _formatPreference?: string | null,
    _options?: unknown,
    progressCallback?: ProgressCallback
): Promise<ImportResult> {
    if (!targetTable) {
        return {
            success: false,
            message: 'Target table name is required.'
        };
    }

    const processor = new ClipboardDataProcessor({ inferBoolean: config.inferBoolean });
    const analyzer = await processor.analyzeClipboardData(progressCallback);
    const headers = normalizeAndDeduplicateHeaders(analyzer.getHeaders(), config.kind);
    const dataTypes = analyzer.getDataTypes().map(typeChooser => normalizeDataType(typeChooser.currentType.toString()));

    if (headers.length === 0) {
        return {
            success: false,
            message: 'No columns found in clipboard data.'
        };
    }

    const totalRows = analyzer.getRowCount();
    if (totalRows === 0) {
        return {
            success: false,
            message: 'No rows found in clipboard data.'
        };
    }

    const columns: ImportColumnDescriptor[] = headers.map((columnName, index) => ({
        sourceIndex: index,
        columnName,
        dataType: dataTypes[index] || 'NVARCHAR(255)'
    }));

    return executeBatchImport(config, {
        targetTable,
        connectionDetails,
        columns,
        rows: analyzer.dataRowIterator(),
        totalRows,
        decimalDelimiter: analyzer.getDecimalDelimiter(),
        progressCallback,
        format: 'CLIPBOARD',
        detectedDelimiter: analyzer.getDelimiter()
    });
}
