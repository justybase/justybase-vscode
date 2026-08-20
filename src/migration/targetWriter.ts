/**
 * Target writers for the cross-database migration feature.
 *
 * Each target dialect gets its optimal load path:
 *  - Netezza:   external table protocol via `registerImportStream` + INSERT ... SELECT FROM EXTERNAL
 *  - PostgreSQL: COPY FROM STDIN via `registerImportStream`
 *  - Db2 / MSSQL: batched multi-row INSERTs
 *  - MySQL / Oracle / SQLite / DuckDB / Vertica / Access: batched INSERTs via the shared
 *    batch import engine (`executeBatchImport`)
 *  - Snowflake: plan-only (no direct bulk load path today)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import type { DatabaseKind } from '../contracts/database';
import {
    createConnectedDatabaseConnectionFromDetails,
    getDatabaseConnectionConstructor,
} from '../core/connectionFactory';
import { formatIdentifierForSql, quoteIdentifier } from '../utils/identifierUtils';
import type { ConnectionDetails } from '../types';
import type { ImportColumnDescriptor } from '../import/dataImporter';
import {
    executeBatchImport,
    executeStatement,
    type BatchImportDialectConfig,
} from '../import/batchImportSupport';
import {
    accessBatchImportConfig,
} from '../import/accessImporter';
import {
    buildNetezzaVirtualImportName,
    destroyNetezzaImportStream,
    registerNetezzaImportStream,
} from '../import/netezzaVirtualImport';
import {
    duckdbBatchImportConfig,
} from '../import/duckdbImporter';
import {
    mysqlBatchImportConfig,
} from '../import/mysqlImporter';
import {
    oracleBatchImportConfig,
} from '../import/oracleImporter';
import {
    sqliteBatchImportConfig,
} from '../import/sqliteImporter';
import {
    verticaBatchImportConfig,
} from '../import/verticaImporter';
import { buildInsertSql as buildDb2InsertSql, parseDb2TargetTable } from '../import/db2Importer';
import { buildInsertSql as buildMssqlInsertSql, parseMsSqlTargetTable } from '../import/mssqlImporter';
import {
    buildCopyFromSql,
    parsePostgreSqlTargetTable,
} from '../import/postgresqlImporter';
import { buildCreateTableDdl, buildTargetQualifiedName, resolveTargetQualificationParts, type DdlColumnSpec } from './ddlBuilder';
import { createMigrationProgress } from './progress';
import { getNumericScaleFromType } from './typeTranslation/parseSqlType';
import type {
    MigrationProgressCallback,
    MigrationTargetSelection,
} from './types';

export interface PreparedTargetColumn {
    sourceIndex: number;
    targetName: string;
    canonicalType: string;
    renderedType: string;
    notNull: boolean;
    isPk: boolean;
    defaultValue?: string;
}

export interface TargetWriterInput {
    targetKind: DatabaseKind;
    target: MigrationTargetSelection;
    targetDetails: ConnectionDetails;
    columns: PreparedTargetColumn[];
    /** User-edited CREATE TABLE DDL; used verbatim instead of the generated one. */
    customCreateTableDdl?: string;
    /** Reserved for future stream tuning; the driver owns socket backpressure. */
    streamBatchSize?: number;
    /** Rows in source column order, formatted string cells. */
    rows: AsyncIterable<string[]>;
    totalRows?: number;
    startedAt: number;
    progressCallback: MigrationProgressCallback;
}

export interface TargetWriteResult {
    rowsInserted: number;
    planOnly?: boolean;
    planMarkdown?: string;
}

const STREAM_TIMEOUT_SECONDS = 7200;
const STREAM_PROGRESS_REPORT_EVERY_ROWS = 5000;

function buildDottedTargetName(
    database: string | undefined,
    schema: string | undefined,
    table: string,
    kind: DatabaseKind,
): string {
    const parts = resolveTargetQualificationParts(kind, database, schema);
    const partsList = [parts.database, parts.schema].filter(
        (part): part is string => Boolean(part && part.trim()),
    );
    if (kind === 'netezza' && parts.database && !parts.schema) {
        return `${parts.database}..${table}`;
    }
    if (partsList.length === 0) {
        return table;
    }
    return `${partsList.join('.')}.${table}`;
}

function toImportColumnDescriptors(columns: PreparedTargetColumn[]): ImportColumnDescriptor[] {
    return columns.map(column => ({
        sourceIndex: column.sourceIndex,
        columnName: column.targetName,
        dataType: column.canonicalType,
    }));
}

function toDdlColumnSpecs(columns: PreparedTargetColumn[]): DdlColumnSpec[] {
    return columns.map(column => ({
        name: column.targetName,
        type: column.renderedType,
        notNull: column.notNull,
        isPk: column.isPk,
        defaultValue: column.defaultValue,
    }));
}

function reportStreamProgress(
    progressCallback: MigrationProgressCallback,
    rowsRead: number,
    totalRows: number | undefined,
    startedAt: number,
    message: string,
): void {
    progressCallback(createMigrationProgress('stream', rowsRead, totalRows, message, startedAt));
}

function buildVirtualStreamName(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.txt`;
}

/**
 * Readable that pulls rows from an async iterable and formats them on demand.
 */
abstract class MigrationRowsReadable extends Readable {
    private rowIterator: AsyncIterator<string[]> | null;
    private isReading = false;
    private rowsPushed = 0;

    constructor(rows: AsyncIterable<string[]>) {
        super();
        this.rowIterator = rows[Symbol.asyncIterator]();
    }

    public get rowsPushedCount(): number {
        return this.rowsPushed;
    }

    protected abstract formatRow(cells: string[]): string;

    protected onRowsPushed(rowsPushed: number): void {
        void rowsPushed;
    }

    _read(_size: number): void {
        if (this.isReading) {
            return;
        }
        this.isReading = true;
        void this.readBatch();
    }

    private async readBatch(): Promise<void> {
        try {
            let more = true;
            let processedInBatch = 0;

            while (more && processedInBatch < 100) {
                if (!this.rowIterator) {
                    this.push(null);
                    this.isReading = false;
                    return;
                }

                const next = await this.rowIterator.next();
                if (next.done) {
                    if (this.rowsPushed > 0 && this.rowsPushed % STREAM_PROGRESS_REPORT_EVERY_ROWS !== 0) {
                        this.onRowsPushed(this.rowsPushed);
                    }
                    this.rowIterator = null;
                    this.push(null);
                    this.isReading = false;
                    return;
                }

                this.rowsPushed++;
                if (this.rowsPushed % STREAM_PROGRESS_REPORT_EVERY_ROWS === 0) {
                    this.onRowsPushed(this.rowsPushed);
                }
                const line = this.formatRow(next.value);
                more = this.push(Buffer.from(line, 'utf8'));
                processedInBatch++;

                if (this.rowsPushed % 500 === 0) {
                    this.isReading = false;
                    setImmediate(() => this._read(0));
                    return;
                }
            }

            this.isReading = false;
        } catch (error) {
            this.isReading = false;
            this.emit('error', error);
        }
    }
}

class NetezzaMigrationReadable extends MigrationRowsReadable {
    private readonly rowFormatter: (cells: string[]) => string;
    private readonly onRow: (rowsRead: number) => void;

    constructor(
        rows: AsyncIterable<string[]>,
        formatRow: (cells: string[]) => string,
        onRow: (rowsRead: number) => void,
        _batchSize?: number,
    ) {
        super(rows);
        this.rowFormatter = formatRow;
        this.onRow = onRow;
    }

    public get rowsReadCount(): number {
        return this.rowsPushedCount;
    }

    protected formatRow(cells: string[]): string {
        return this.rowFormatter(cells);
    }

    protected onRowsPushed(rowsRead: number): void {
        this.onRow(rowsRead);
    }
}

function escapeTabularValue(value: string, escapeChar: string, valuesToEscape: string[]): string {
    let result = String(value).trim();
    for (const char of valuesToEscape) {
        result = result.split(char).join(`${escapeChar}${char}`);
    }
    return result;
}

function truncateNumericValue(value: string, scale: number, decimalDelimiter: string): string {
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

function normalizeBooleanText(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (['true', 't', 'yes', 'y', '1'].includes(normalized)) {
        return '1';
    }
    if (['false', 'f', 'no', 'n', '0'].includes(normalized)) {
        return '0';
    }
    return value.trim();
}

/* ------------------------------------------------------------------ */
/* Netezza                                                             */
/* ------------------------------------------------------------------ */

const NETEZZA_DELIMITER = '\t';
const NETEZZA_RECORD_DELIM = '\n';
const NETEZZA_ESCAPE_CHAR = '\\';

function buildNetezzaUsingClause(logDir: string): string {
    const logDirUnix = logDir.replace(/\\/g, '/');
    return `    USING
    (
        REMOTESOURCE 'jdbc'
        DELIMITER '\\t'
        RecordDelim '\\n'
        ESCAPECHAR '${NETEZZA_ESCAPE_CHAR}'
        NULLVALUE ''
        ENCODING 'Utf-8'
        TIMESTYLE '24hour'
        BOOLSTYLE '1_0'
        SKIPROWS 0
        MAXERRORS 1
        COMPRESS FALSE
        LOGDIR '${logDirUnix}'
    )`;
}

function quoteNetezzaQualifiedName(name: string): string {
    return name
        .split('.')
        .map(part => part.trim() ? quoteIdentifier(part.trim()) : '')
        .join('.');
}

/**
 * Netezza external tables reject CHAR/VARCHAR definitions when ENCODING 'Utf-8'
 * is in effect; NVARCHAR variants are required for unicode streams.
 */
function toNetezzaExternalType(column: PreparedTargetColumn): string {
    const normalized = column.renderedType.trim().toUpperCase();
    const match = normalized.match(/^(CHAR|VARCHAR)\(\s*(\d+)\s*\)$/);
    if (match) {
        // Netezza requires the unicode character type when UTF-8 encoding is
        // enabled for an external table.
        return `NVARCHAR(${match[2]})`;
    }
    return normalized;
}

function buildNetezzaLoadSql(
    virtualFileName: string,
    qualifiedName: string,
    columns: PreparedTargetColumn[],
    logDir: string,
): string {
    const externalColumns = columns.map(
        column => `        ${quoteIdentifier(column.targetName)} ${toNetezzaExternalType(column)}`,
    );
    const selectColumns = columns.map(column => {
        const name = quoteIdentifier(column.targetName);
        // Keep the external value expression uncast. Netezza performs the
        // assignment conversion when inserting into the target table, while
        // explicit casts between DATETIME/TIMESTAMP and unicode character
        // types are not accepted consistently by all NPS versions.
        return `        ${name}`;
    });
    const targetColumns = columns
        .map(column => quoteIdentifier(column.targetName))
        .join(', ');

    return `INSERT INTO ${quoteNetezzaQualifiedName(qualifiedName)} (${targetColumns})
SELECT
${selectColumns.join(',\n')}
FROM EXTERNAL '${virtualFileName}'
(
${externalColumns.join(',\n')}
)
${buildNetezzaUsingClause(logDir)};`;
}

function getCanonicalBaseType(canonicalType: string): string {
    const parenIndex = canonicalType.indexOf('(');
    return (parenIndex >= 0 ? canonicalType.slice(0, parenIndex) : canonicalType).trim();
}

function formatNetezzaRow(cells: string[], columns: PreparedTargetColumn[]): string {
    const valuesToEscape = [
        NETEZZA_ESCAPE_CHAR,
        NETEZZA_RECORD_DELIM,
        '\r',
        NETEZZA_DELIMITER,
    ];
    const formattedCells = columns.map(column => {
        const rawValue = cells[column.sourceIndex] ?? '';
        const baseType = getCanonicalBaseType(column.canonicalType);
        let result = escapeTabularValue(rawValue, NETEZZA_ESCAPE_CHAR, valuesToEscape);

        if (baseType === 'BOOLEAN') {
            result = normalizeBooleanText(result);
        } else if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
            result = result.replace('T', ' ');
        } else if (baseType === 'BIGINT' || baseType === 'NUMERIC' || baseType === 'DECIMAL') {
            result = result.replace(/\s/g, '');
            if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
                const scale = getNumericScaleFromType(column.canonicalType) ?? 0;
                if (scale > 0) {
                    result = truncateNumericValue(result, scale, '.');
                }
                result = result.replace(',', '.');
            }
        }

        return result;
    });

    return formattedCells.join(NETEZZA_DELIMITER) + NETEZZA_RECORD_DELIM;
}

async function writeToNetezza(input: TargetWriterInput): Promise<TargetWriteResult> {
    const targetDatabase = input.target.database
        && input.targetDetails.database
        && input.target.database.trim().toUpperCase() === input.targetDetails.database.trim().toUpperCase()
        ? undefined
        : input.target.database;
    const qualifiedName = buildTargetQualifiedName(
        targetDatabase,
        input.target.schema,
        input.target.table,
        'netezza',
    );
    const virtualFileName = buildNetezzaVirtualImportName('virtual_migration_import');
    const logDir = path.join(os.tmpdir(), 'netezza_migration_logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    let rowsRead = 0;
    const stream = new NetezzaMigrationReadable(
        input.rows,
        cells => formatNetezzaRow(cells, input.columns),
        streamedRows => {
            rowsRead = streamedRows;
            reportStreamProgress(
                input.progressCallback,
                streamedRows,
                input.totalRows,
                input.startedAt,
                `Streaming rows to Netezza external table (${streamedRows.toLocaleString()} rows)...`,
            );
        },
        input.streamBatchSize,
    );
    let unregisterImportStream: (() => void) | undefined;
    try {
        unregisterImportStream = registerNetezzaImportStream(virtualFileName, stream);

        const connection = await createConnectedDatabaseConnectionFromDetails(input.targetDetails);
        try {
            let lastReportedPercent = -1;
            connection.on('importProgress', progressData => {
                const progress = progressData as { percentComplete?: number };
                if (typeof progress.percentComplete === 'number') {
                    const percent = Math.floor(progress.percentComplete);
                    if (percent !== lastReportedPercent) {
                        lastReportedPercent = percent;
                        input.progressCallback(
                            createMigrationProgress(
                                'finalize',
                                rowsRead,
                                input.totalRows,
                                `Netezza external load: ${progress.percentComplete}%`,
                                input.startedAt,
                            ),
                        );
                    }
                }
            });
            if (!input.target.appendToExistingTable) {
                const createDdl = input.customCreateTableDdl ?? buildCreateTableDdl(
                    'netezza',
                    quoteNetezzaQualifiedName(qualifiedName),
                    toDdlColumnSpecs(input.columns),
                );
                input.progressCallback(
                    createMigrationProgress('finalize', 0, input.totalRows, 'Creating target table...', input.startedAt),
                );
                await executeStatement(connection, createDdl, STREAM_TIMEOUT_SECONDS);
            }

            const loadSql = buildNetezzaLoadSql(virtualFileName, qualifiedName, input.columns, logDir);
            input.progressCallback(
                createMigrationProgress(
                    'finalize',
                    rowsRead,
                    input.totalRows,
                    'Finalizing on Netezza (loading external table)...',
                    input.startedAt,
                ),
            );

            const command = connection.createCommand(loadSql);
            command.commandTimeout = 3600;
            await command.execute();
            rowsRead = stream.rowsReadCount;

            return { rowsInserted: rowsRead };
        } finally {
            await connection.close().catch(() => undefined);
        }
    } finally {
        unregisterImportStream?.();
        destroyNetezzaImportStream(stream);
    }
}

/* ------------------------------------------------------------------ */
/* PostgreSQL                                                          */
/* ------------------------------------------------------------------ */

const POSTGRESQL_COPY_DELIMITER = '\t';

class PostgreSqlMigrationReadable extends MigrationRowsReadable {
    constructor(
        rows: AsyncIterable<string[]>,
        private readonly columns: PreparedTargetColumn[],
        private readonly onRow: (rowsRead: number) => void,
    ) {
        super(rows);
    }

    protected onRowsPushed(rowsPushed: number): void {
        this.onRow(rowsPushed);
    }

    protected formatRow(cells: string[]): string {
        const formattedCells = this.columns.map(column => {
            const rawValue = cells[column.sourceIndex] ?? '';
            const baseType = getCanonicalBaseType(column.canonicalType);
            let normalized = rawValue.trim();

            if (!normalized) {
                return '';
            }
            if (baseType === 'BOOLEAN') {
                normalized = normalizeBooleanText(normalized);
            } else if (baseType === 'DATE') {
                normalized = normalizeDateText(normalized);
            } else if (baseType === 'DATETIME' || baseType === 'TIMESTAMP') {
                normalized = normalizeTimestampText(normalized);
            } else if (baseType === 'NUMERIC' || baseType === 'DECIMAL') {
                const scale = getNumericScaleFromType(column.canonicalType) ?? 0;
                if (scale > 0) {
                    normalized = truncateNumericValue(normalized, scale, '.');
                }
                normalized = normalized.replace(',', '.');
            }

            let escaped = normalized;
            for (const char of ['\\', '\n', '\r', POSTGRESQL_COPY_DELIMITER]) {
                escaped = escaped.split(char).join(`\\${char}`);
            }
            return escaped;
        });

        return formattedCells.join(POSTGRESQL_COPY_DELIMITER) + '\n';
    }
}

function normalizeDateText(value: string): string {
    const isoMatch = value.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (isoMatch) {
        const [, year, month, day] = isoMatch;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    const localMatch = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!localMatch) {
        return value;
    }
    const [, day, month, year] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function normalizeTimestampText(value: string): string {
    const normalizedValue = value.replace('T', ' ');
    const isoMatch = normalizedValue.match(
        /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
    );
    if (isoMatch) {
        const [, year, month, day, hour = '00', minute = '00', second = '00'] = isoMatch;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
    }
    const localMatch = normalizedValue.match(
        /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/,
    );
    if (!localMatch) {
        return normalizedValue;
    }
    const [, day, month, year, hour = '00', minute = '00', second = '00'] = localMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

async function writeToPostgreSql(input: TargetWriterInput): Promise<TargetWriteResult> {
    const connectionConstructor = getDatabaseConnectionConstructor('postgresql');
    if (!connectionConstructor.registerImportStream) {
        throw new Error('Active PostgreSQL driver does not support stream registry.');
    }

    const dottedName = buildDottedTargetName(input.target.database, input.target.schema, input.target.table, 'postgresql');
    const parsedTarget = parsePostgreSqlTargetTable(dottedName, input.targetDetails);
    const qualifiedName = buildTargetQualifiedName(
        input.target.database,
        input.target.schema,
        input.target.table,
        'postgresql',
    );

    const streamName = buildVirtualStreamName('virtual_postgresql_migration');
    let rowsRead = 0;
    const stream = new PostgreSqlMigrationReadable(
        input.rows,
        input.columns,
        streamedRows => {
            rowsRead = streamedRows;
            reportStreamProgress(
                input.progressCallback,
                streamedRows,
                input.totalRows,
                input.startedAt,
                `Streaming rows to PostgreSQL COPY (${streamedRows.toLocaleString()} rows)...`,
            );
        },
    );
    connectionConstructor.registerImportStream(streamName, stream);

    const connection = await createConnectedDatabaseConnectionFromDetails({
        ...input.targetDetails,
        dbType: 'postgresql',
    });
    try {
        if (!input.target.appendToExistingTable) {
            const createDdl = input.customCreateTableDdl ?? buildCreateTableDdl('postgresql', qualifiedName, toDdlColumnSpecs(input.columns));
            input.progressCallback(
                createMigrationProgress('finalize', 0, input.totalRows, 'Creating target table...', input.startedAt),
            );
            await executeStatement(connection, createDdl, STREAM_TIMEOUT_SECONDS);
        }

        const copyColumnsWithTypes = input.columns.map(column => ({
            sourceIndex: column.sourceIndex,
            columnName: column.targetName,
            dataType: column.renderedType,
        }));
        const copySql = buildCopyFromSql(parsedTarget, copyColumnsWithTypes, POSTGRESQL_COPY_DELIMITER, streamName);
        input.progressCallback(
            createMigrationProgress(
                'finalize',
                rowsRead,
                input.totalRows,
                'Finalizing on PostgreSQL (COPY FROM STDIN)...',
                input.startedAt,
            ),
        );

        const command = connection.createCommand(copySql);
        command.commandTimeout = STREAM_TIMEOUT_SECONDS;
        await command.execute();
        rowsRead = stream.rowsPushedCount;

        return { rowsInserted: rowsRead };
    } finally {
        await connection.close().catch(() => undefined);
        if (connectionConstructor.unregisterImportStream) {
            connectionConstructor.unregisterImportStream(streamName);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Db2 / MS SQL Server (batched INSERT with shared helpers)            */
/* ------------------------------------------------------------------ */

interface BatchedInsertTarget {
    qualifiedName: string;
    displayName: string;
}

interface BatchedInsertDialect {
    kind: DatabaseKind;
    insertBatchSize: number;
    parseTarget(dottedName: string, details: ConnectionDetails): BatchedInsertTarget;
    buildCreateSql(qualifiedName: string, columns: PreparedTargetColumn[]): string;
    buildInsertSql(
        target: BatchedInsertTarget,
        columns: PreparedTargetColumn[],
        batch: string[][],
    ): string;
}

function buildGenericCreateSql(
    kind: DatabaseKind,
    qualifiedName: string,
    columns: PreparedTargetColumn[],
): string {
    return buildCreateTableDdl(kind, qualifiedName, toDdlColumnSpecs(columns));
}

async function writeWithBatchedInserts(
    input: TargetWriterInput,
    dialect: BatchedInsertDialect,
): Promise<TargetWriteResult> {
    const dottedName = buildDottedTargetName(
        input.target.database,
        input.target.schema,
        input.target.table,
        dialect.kind,
    );
    const target = dialect.parseTarget(dottedName, input.targetDetails);

    const connection = await createConnectedDatabaseConnectionFromDetails({
        ...input.targetDetails,
        dbType: dialect.kind,
    });
    let rowsInserted = 0;
    let rowsRead = 0;
    let batch: string[][] = [];

    try {
        if (!input.target.appendToExistingTable) {
            input.progressCallback(
                createMigrationProgress('finalize', 0, input.totalRows, 'Creating target table...', input.startedAt),
            );
            await executeStatement(connection, input.customCreateTableDdl ?? dialect.buildCreateSql(target.qualifiedName, input.columns), 3600);
        }

        for await (const row of input.rows) {
            rowsRead++;
            batch.push(row);
            if (batch.length >= dialect.insertBatchSize) {
                await executeStatement(
                    connection,
                    dialect.buildInsertSql(target, input.columns, batch),
                    3600,
                );
                rowsInserted += batch.length;
                batch = [];
                reportStreamProgress(
                    input.progressCallback,
                    rowsRead,
                    input.totalRows,
                    input.startedAt,
                    `Inserting rows into ${target.displayName} (${rowsInserted.toLocaleString()} inserted)...`,
                );
            }
        }

        if (batch.length > 0) {
            await executeStatement(connection, dialect.buildInsertSql(target, input.columns, batch), 3600);
            rowsInserted += batch.length;
        }

        input.progressCallback(
            createMigrationProgress(
                'finalize',
                rowsRead,
                input.totalRows,
                'Finalizing target load...',
                input.startedAt,
            ),
        );

        return { rowsInserted };
    } finally {
        await connection.close().catch(() => undefined);
    }
}

function buildDb2BatchedDialect(): BatchedInsertDialect {
    return {
        kind: 'db2',
        insertBatchSize: 100,
        parseTarget: (dottedName, details) => parseDb2TargetTable(dottedName, details),
        buildCreateSql: (qualifiedName, columns) =>
            buildGenericCreateSql('db2', qualifiedName, columns),
        buildInsertSql: (target, columns, batch) =>
            buildDb2InsertSql(target as Parameters<typeof buildDb2InsertSql>[0], toImportColumnDescriptors(columns), batch, '.'),
    };
}

function buildMsSqlBatchedDialect(): BatchedInsertDialect {
    return {
        kind: 'mssql',
        insertBatchSize: 100,
        parseTarget: (dottedName, details) => parseMsSqlTargetTable(dottedName, details),
        buildCreateSql: (qualifiedName, columns) =>
            buildGenericCreateSql('mssql', qualifiedName, columns),
        buildInsertSql: (target, columns, batch) =>
            buildMssqlInsertSql(target as Parameters<typeof buildMssqlInsertSql>[0], toImportColumnDescriptors(columns), batch, '.'),
    };
}

/* ------------------------------------------------------------------ */
/* Batch import engine dialects (MySQL, Oracle, SQLite, DuckDB, ...)   */
/* ------------------------------------------------------------------ */

function getBatchImportConfig(kind: DatabaseKind): BatchImportDialectConfig {
    switch (kind) {
        case 'mysql': return mysqlBatchImportConfig;
        case 'oracle': return oracleBatchImportConfig;
        case 'sqlite': return sqliteBatchImportConfig;
        case 'duckdb': return duckdbBatchImportConfig;
        case 'vertica': return verticaBatchImportConfig;
        case 'access': return accessBatchImportConfig;
        default:
            throw new Error(`No batch import engine registered for target dialect "${kind}".`);
    }
}

async function writeToBatchEngine(input: TargetWriterInput): Promise<TargetWriteResult> {
    const config = getBatchImportConfig(input.targetKind);
    const dottedName = buildDottedTargetName(
        input.target.database,
        input.target.schema,
        input.target.table,
        input.targetKind,
    );

    let rowsRead = 0;
    async function* countingRows(): AsyncGenerator<string[], void, unknown> {
        for await (const row of input.rows) {
            rowsRead++;
            yield row;
        }
    }

    const connection = await createConnectedDatabaseConnectionFromDetails({
        ...input.targetDetails,
        dbType: input.targetKind,
    });
    try {
        if (!input.target.appendToExistingTable) {
            const qualifiedName = buildTargetQualifiedName(
                input.target.database,
                input.target.schema,
                input.target.table,
                input.targetKind,
            );
            input.progressCallback(
                createMigrationProgress('finalize', 0, input.totalRows, 'Creating target table...', input.startedAt),
            );
            await executeStatement(connection, input.customCreateTableDdl ?? buildCreateTableDdl(input.targetKind, qualifiedName, toDdlColumnSpecs(input.columns)), 3600);
        }
    } finally {
        await connection.close().catch(() => undefined);
    }

    const result = await executeBatchImport(config, {
        targetTable: dottedName,
        connectionDetails: input.targetDetails,
        columns: toImportColumnDescriptors(input.columns),
        appendToExistingTable: true,
        rows: countingRows(),
        totalRows: Math.max(1, input.totalRows ?? 1),
        decimalDelimiter: '.',
        format: 'MIGRATION',
        progressCallback: (message) => {
            if (message.includes('/')) {
                reportStreamProgress(
                    input.progressCallback,
                    rowsRead,
                    input.totalRows,
                    input.startedAt,
                    `Inserting rows into target (${rowsRead.toLocaleString()} rows)...`,
                );
            } else {
                input.progressCallback(
                    createMigrationProgress('finalize', rowsRead, input.totalRows, message, input.startedAt),
                );
            }
        },
    });

    input.progressCallback(
        createMigrationProgress('finalize', rowsRead, input.totalRows, 'Finalizing target load...', input.startedAt),
    );

    if (!result.success) {
        throw new Error(result.message);
    }

    return { rowsInserted: result.details?.rowsInserted ?? rowsRead };
}

/* ------------------------------------------------------------------ */
/* Snowflake (plan only)                                               */
/* ------------------------------------------------------------------ */

function buildSnowflakePlanMarkdown(input: TargetWriterInput): string {
    const qualifiedName = buildTargetQualifiedName(
        input.target.database,
        input.target.schema,
        input.target.table,
        'snowflake',
    );
    const createDdl = input.customCreateTableDdl ?? buildCreateTableDdl('snowflake', qualifiedName, toDdlColumnSpecs(input.columns));
    const columnList = input.columns
        .map(column => formatIdentifierForSql(column.targetName, 'snowflake'))
        .join(', ');
    const loadSql = `COPY INTO ${qualifiedName} (${columnList})\nFROM @migration_stage\nFILE_FORMAT = (TYPE = CSV, FIELD_DELIMITER = '\\t', NULL_IF = ('', 'NULL'), EMPTY_FIELD_AS_NULL = TRUE);`;

    return [
        '# Snowflake migration plan',
        '',
        'Snowflake does not expose a direct bulk load path through this extension;',
        'the plan below needs to be executed on the Snowflake side (stage + COPY INTO).',
        '',
        '## CREATE TABLE',
        '```sql',
        createDdl,
        '```',
        '',
        '## Load SQL (after uploading the exported data to a stage)',
        '```sql',
        loadSql,
        '```',
    ].join('\n');
}

async function writeToSnowflake(input: TargetWriterInput): Promise<TargetWriteResult> {
    const planMarkdown = buildSnowflakePlanMarkdown(input);
    input.progressCallback(
        createMigrationProgress('done', 0, input.totalRows, 'Snowflake plan generated (no direct load).', input.startedAt),
    );
    return { rowsInserted: 0, planOnly: true, planMarkdown };
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export async function writeToTarget(input: TargetWriterInput): Promise<TargetWriteResult> {
    switch (input.targetKind) {
        case 'netezza':
            return writeToNetezza(input);
        case 'postgresql':
            return writeToPostgreSql(input);
        case 'db2':
            return writeWithBatchedInserts(input, buildDb2BatchedDialect());
        case 'mssql':
            return writeWithBatchedInserts(input, buildMsSqlBatchedDialect());
        case 'snowflake':
            return writeToSnowflake(input);
        default:
            return writeToBatchEngine(input);
    }
}
