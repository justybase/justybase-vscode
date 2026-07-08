import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import type { DatabaseConnection, DatabaseImportTypeMapper } from '../contracts/database';
import {
    createConnectedDatabaseConnectionFromDetails,
    getDatabaseConnectionConstructor,
    getRequiredDatabaseImportTypeMapper
} from '../core/connectionFactory';
import type { ConnectionDetails } from '../types';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../utils/identifierUtils';
import { ClipboardDataProcessor } from './clipboardImporter';
import {
    ImportColumnDescriptor,
    ImportColumnOptions,
    ImportResult,
    ProgressCallback
} from './dataImporter';
import { normalizeAndDeduplicateHeaders } from './importHeaderUtils';
import { createTabularDataImporter } from './tabularDataImporter';

const POSTGRESQL_COPY_STREAM_MARKER = 'JBL_IMPORT_STREAM';
const POSTGRESQL_DEFAULT_TIMEOUT_SECONDS = 3600;
const SUPPORTED_FILE_FORMATS = ['.csv', '.txt', '.xlsx', '.xlsb'];

interface PostgreSqlTargetTable {
    providedDatabase?: string;
    schema?: string;
    table: string;
    qualifiedName: string;
    displayName: string;
}

interface ParsedImportTypeSpec {
    dbType: string;
    precision?: number;
    scale?: number;
    length?: number;
}

interface PostgreSqlImportExecutionOptions {
    targetTable: string;
    connectionDetails: ConnectionDetails;
    columns: ImportColumnDescriptor[];
    rows: Iterable<string[]>;
    totalRows: number;
    decimalDelimiter: string;
    copyDelimiter: string;
    progressCallback?: ProgressCallback;
    timeoutSeconds?: number;
    sourceFile?: string;
    fileSize?: number;
    format: string;
    detectedDelimiter?: string;
}

function normalizeImportType(typeName: string): string {
    return typeName.trim().replace(/\s+/g, ' ').toUpperCase();
}

function getBaseImportType(typeName: string): string {
    const normalizedType = normalizeImportType(typeName);
    const parenIndex = normalizedType.indexOf('(');
    return (parenIndex >= 0 ? normalizedType.slice(0, parenIndex) : normalizedType).trim();
}

function getNumericScale(typeName: string): number | null {
    const match = normalizeImportType(typeName).match(/^(NUMERIC|DECIMAL)\(\s*\d+\s*,\s*(\d+)\s*\)$/);
    return match ? Number(match[2]) : null;
}

function parseImportTypeSpec(typeName: string): ParsedImportTypeSpec {
    const normalizedType = normalizeImportType(typeName);
    const numericMatch = normalizedType.match(/^([A-Z][A-Z0-9_ ]*)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
    if (numericMatch) {
        return {
            dbType: numericMatch[1].trim(),
            precision: Number(numericMatch[2]),
            scale: Number(numericMatch[3])
        };
    }

    const singleArgumentMatch = normalizedType.match(/^([A-Z][A-Z0-9_ ]*)\(\s*(\d+)\s*\)$/);
    if (singleArgumentMatch) {
        const dbType = singleArgumentMatch[1].trim();
        const numericValue = Number(singleArgumentMatch[2]);
        if (dbType === 'NUMERIC' || dbType === 'DECIMAL') {
            return {
                dbType,
                precision: numericValue
            };
        }

        return {
            dbType,
            length: numericValue
        };
    }

    return {
        dbType: normalizedType
    };
}

function mapImportTypeToPostgreSqlType(typeMapper: DatabaseImportTypeMapper, typeName: string): string {
    const parsedType = parseImportTypeSpec(typeName);
    return typeMapper.createDataType(
        parsedType.dbType,
        parsedType.precision,
        parsedType.scale,
        parsedType.length
    ).toString();
}

export function mapImportColumnsToPostgreSql(
    columns: ImportColumnDescriptor[],
    typeMapper: DatabaseImportTypeMapper
): ImportColumnDescriptor[] {
    return columns.map(column => ({
        ...column,
        dataType: mapImportTypeToPostgreSqlType(typeMapper, column.dataType)
    }));
}

export function parsePostgreSqlTargetTable(targetTable: string, connectionDetails: ConnectionDetails): PostgreSqlTargetTable {
    const parts = targetTable
        .split('.')
        .map(part => part.trim())
        .filter(part => part.length > 0);

    if (parts.length === 0 || parts.length > 3) {
        throw new Error('Invalid target table format. Use TABLE, SCHEMA.TABLE, or DATABASE.SCHEMA.TABLE.');
    }

    if (parts.length === 1) {
        const [table] = parts;
        return {
            table,
            qualifiedName: formatIdentifierForSql(table, 'postgresql'),
            displayName: table
        };
    }

    if (parts.length === 2) {
        const [schema, table] = parts;
        return {
            schema,
            table,
            qualifiedName: formatQualifiedObjectName(undefined, schema, table, 'postgresql'),
            displayName: `${schema}.${table}`
        };
    }

    const [providedDatabase, schema, table] = parts;
    const activeDatabase = connectionDetails.database.trim();
    if (activeDatabase && providedDatabase.toUpperCase() !== activeDatabase.toUpperCase()) {
        throw new Error(
            `PostgreSQL import runs against active database "${activeDatabase}". ` +
            `Provided database "${providedDatabase}" does not match the active connection.`
        );
    }

    return {
        providedDatabase,
        schema,
        table,
        qualifiedName: formatQualifiedObjectName(undefined, schema, table, 'postgresql'),
        displayName: `${providedDatabase}.${schema}.${table}`
    };
}

export function buildCreateTableSql(target: PostgreSqlTargetTable, columns: ImportColumnDescriptor[]): string {
    const columnDefinitions = columns.map(column =>
        `    ${formatIdentifierForSql(column.columnName, 'postgresql')} ${column.dataType}`
    );

    return `CREATE TABLE ${target.qualifiedName} (\n${columnDefinitions.join(',\n')}\n)`;
}

function buildCopyDelimiterLiteral(delimiter: string): string {
    if (delimiter === '\t') {
        return "E'\\t'";
    }

    return `'${delimiter.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function buildCopyFromSql(target: PostgreSqlTargetTable, columns: ImportColumnDescriptor[], delimiter: string, streamName: string): string {
    const columnList = columns
        .map(column => formatIdentifierForSql(column.columnName, 'postgresql'))
        .join(', ');

    return `COPY ${target.qualifiedName} (${columnList}) FROM STDIN WITH (` +
        `FORMAT text, DELIMITER ${buildCopyDelimiterLiteral(delimiter)}, NULL '', ENCODING 'UTF8'` +
        `) /* ${POSTGRESQL_COPY_STREAM_MARKER}:${streamName} */`;
}

function normalizeDateValue(value: string): string {
    const dateMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!dateMatch) {
        return value;
    }

    const [, day, month, year] = dateMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function normalizeTimestampValue(value: string): string {
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

function normalizeValueForCopy(value: string, dataType: string, decimalDelimiter: string): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }

    const baseType = getBaseImportType(dataType);

    if (baseType === 'DATE') {
        return normalizeDateValue(trimmed);
    }

    if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
        return normalizeTimestampValue(trimmed);
    }

    if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
        let normalized = trimmed;
        const declaredScale = getNumericScale(dataType) ?? 0;
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

function escapeCopyTextValue(value: string, delimiter: string): string {
    let escaped = value;
    for (const char of ['\\', '\n', '\r', delimiter]) {
        escaped = escaped.split(char).join(`\\${char}`);
    }
    return escaped;
}

function formatCopyValue(value: string, dataType: string, decimalDelimiter: string, delimiter: string): string {
    const normalizedValue = normalizeValueForCopy(value, dataType, decimalDelimiter);
    return escapeCopyTextValue(normalizedValue, delimiter);
}

function buildVirtualStreamName(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.txt`;
}

class PostgreSqlCopyDataStream extends Readable {
    private readonly _rowIterator: Iterator<string[]>;
    private readonly _recordDelimiter = '\n';
    private _currentIndex = 0;
    private _lastReportTime = 0;
    private _isReading = false;

    public constructor(
        rows: Iterable<string[]>,
        private readonly _columns: ImportColumnDescriptor[],
        private readonly _decimalDelimiter: string,
        private readonly _totalRows: number,
        private readonly _delimiter: string,
        private readonly _progressCallback?: ProgressCallback
    ) {
        super();
        this._rowIterator = rows[Symbol.iterator]();
    }

    _read(_size: number): void {
        if (this._isReading) {
            return;
        }

        this._isReading = true;
        this.readBatch();
    }

    private readBatch(): void {
        try {
            let more = true;
            let processedInBatch = 0;
            const batchSize = 100;

            while (more && processedInBatch < batchSize) {
                const nextRow = this._rowIterator.next();
                if (nextRow.done) {
                    this.reportProgress(true);
                    this._isReading = false;
                    this.push(null);
                    return;
                }

                const line = this._columns
                    .map(column => formatCopyValue(
                        nextRow.value[column.sourceIndex] ?? '',
                        column.dataType,
                        this._decimalDelimiter,
                        this._delimiter
                    ))
                    .join(this._delimiter) + this._recordDelimiter;

                more = this.push(Buffer.from(line, 'utf8'));
                this._currentIndex++;
                processedInBatch++;

                if (this._currentIndex % 500 === 0) {
                    this.reportProgress(false);
                    this._isReading = false;
                    setImmediate(() => this._read(0));
                    return;
                }
            }

            this.reportProgress(false);
            this._isReading = false;
        } catch (error) {
            this._isReading = false;
            this.emit('error', error);
        }
    }

    private reportProgress(force: boolean): void {
        if (!this._progressCallback || this._totalRows <= 0) {
            return;
        }

        const now = Date.now();
        if (!force && now - this._lastReportTime < 1000) {
            return;
        }

        const percent = Math.floor((this._currentIndex / this._totalRows) * 100);
        this._progressCallback(
            `Streaming COPY data: ${percent}% (${this._currentIndex.toLocaleString()}/${this._totalRows.toLocaleString()})`,
            undefined,
            false
        );
        this._lastReportTime = now;
    }
}

function registerImportStream(streamName: string, stream: Readable): void {
    const connectionConstructor = getDatabaseConnectionConstructor('postgresql');
    if (!connectionConstructor.registerImportStream) {
        throw new Error('Active PostgreSQL driver does not support stream registry.');
    }

    connectionConstructor.registerImportStream(streamName, stream);
}

function unregisterImportStream(streamName: string): void {
    const connectionConstructor = getDatabaseConnectionConstructor('postgresql');
    if (connectionConstructor.unregisterImportStream) {
        connectionConstructor.unregisterImportStream(streamName);
    }
}

async function executeStatement(connection: DatabaseConnection, sql: string, timeoutSeconds: number): Promise<void> {
    const command = connection.createCommand(sql);
    command.commandTimeout = timeoutSeconds;
    await command.execute();
}

async function executePostgreSqlCopyImport(options: PostgreSqlImportExecutionOptions): Promise<ImportResult> {
    const startTime = Date.now();
    let connection: DatabaseConnection | null = null;
    let streamName: string | undefined;

    try {
        const target = parsePostgreSqlTargetTable(options.targetTable, options.connectionDetails);
        if (options.columns.length === 0) {
            throw new Error('No columns selected for import.');
        }
        if (options.totalRows === 0) {
            throw new Error('No data rows found in source.');
        }

        streamName = buildVirtualStreamName('virtual_postgresql_import');
        const copyStream = new PostgreSqlCopyDataStream(
            options.rows,
            options.columns,
            options.decimalDelimiter,
            options.totalRows,
            options.copyDelimiter,
            options.progressCallback
        );

        registerImportStream(streamName, copyStream);

        connection = await createConnectedDatabaseConnectionFromDetails({
            ...options.connectionDetails,
            dbType: 'postgresql'
        });

        const timeoutSeconds = options.timeoutSeconds || POSTGRESQL_DEFAULT_TIMEOUT_SECONDS;
        options.progressCallback?.(`Creating target table ${target.displayName}...`);
        await executeStatement(connection, buildCreateTableSql(target, options.columns), timeoutSeconds);

        options.progressCallback?.(`Loading ${options.totalRows.toLocaleString()} rows with PostgreSQL COPY...`);
        await executeStatement(
            connection,
            buildCopyFromSql(target, options.columns, options.copyDelimiter, streamName),
            timeoutSeconds
        );

        const processingTime = (Date.now() - startTime) / 1000;
        return {
            success: true,
            message: `Successfully imported ${options.totalRows.toLocaleString()} rows to ${target.displayName}`,
            details: {
                sourceFile: options.sourceFile,
                targetTable: target.displayName,
                fileSize: options.fileSize,
                format: options.format,
                rowsProcessed: options.totalRows,
                rowsInserted: options.totalRows,
                processingTime: `${processingTime.toFixed(2)} seconds`,
                columns: options.columns.length,
                detectedDelimiter: options.detectedDelimiter
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
        if (streamName) {
            unregisterImportStream(streamName);
        }
    }
}

export async function importDataToPostgreSql(
    filePath: string,
    targetTable: string,
    connectionDetails: ConnectionDetails,
    progressCallback?: ProgressCallback,
    timeoutSeconds?: number,
    columnOptions?: ImportColumnOptions
): Promise<ImportResult> {
    if (!filePath || !fs.existsSync(filePath)) {
        return {
            success: false,
            message: `Source file not found: ${filePath}`
        };
    }

    if (!targetTable) {
        return {
            success: false,
            message: 'Target table name is required.'
        };
    }

    if (!connectionDetails || !connectionDetails.host) {
        return {
            success: false,
            message: 'Connection details are required.'
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
    const importer = createTabularDataImporter(filePath, targetTable, { kind: 'postgresql' });
    await importer.analyzeDataTypes(progressCallback);
    importer.applyColumnOptions(columnOptions);

    const typeMapper = getRequiredDatabaseImportTypeMapper('postgresql');
    const rows = await importer.getAllRows();
    const columns = mapImportColumnsToPostgreSql(importer.getEffectiveColumnDescriptors(), typeMapper);

    return executePostgreSqlCopyImport({
        targetTable,
        connectionDetails,
        columns,
        rows,
        totalRows: rows.length,
        decimalDelimiter: importer.getDecimalDelimiter(),
        copyDelimiter: importer.getCsvDelimiter(),
        progressCallback,
        timeoutSeconds,
        sourceFile: filePath,
        fileSize: fs.statSync(filePath).size,
        format: path.extname(filePath).replace('.', '').toUpperCase() || 'UNKNOWN',
        detectedDelimiter: importer.getCsvDelimiter()
    });
}

export async function importClipboardDataToPostgreSql(
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

    if (!connectionDetails || !connectionDetails.host) {
        return {
            success: false,
            message: 'Connection details are required.'
        };
    }

    const processor = new ClipboardDataProcessor();
    const analyzer = await processor.analyzeClipboardData(progressCallback);
    const rawHeaders = analyzer.getHeaders();
    const headers = normalizeAndDeduplicateHeaders(rawHeaders);
    const typeMapper = getRequiredDatabaseImportTypeMapper('postgresql');
    const columns: ImportColumnDescriptor[] = headers.map((columnName, index) => ({
        sourceIndex: index,
        columnName,
        dataType: mapImportTypeToPostgreSqlType(
            typeMapper,
            analyzer.getDataTypes()[index]?.currentType.toString() || 'NVARCHAR(255)'
        )
    }));

    return executePostgreSqlCopyImport({
        targetTable,
        connectionDetails,
        columns,
        rows: analyzer.dataRowIterator(),
        totalRows: analyzer.getRowCount(),
        decimalDelimiter: analyzer.getDecimalDelimiter(),
        copyDelimiter: '\t',
        progressCallback,
        format: 'CLIPBOARD',
        detectedDelimiter: analyzer.getDelimiter()
    });
}
