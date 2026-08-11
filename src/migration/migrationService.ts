/**
 * Migration service orchestrator.
 *
 * Pipeline:
 *  1. `analyzeSource`     — resolve source columns (table metadata or result
 *                           metadata + bounded fallback sampling for SQL mode)
 *  2. `buildPlan`         — translate types, render DDL, build mapping grid
 *  3. `countSourceRows`   — optional explicit count for progress forecasting
 *  4. `execute`           — open a pull-based source reader, stream rows into
 *                           the target writer, keep status at 100% while the
 *                           target finalizes.
 */

import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import { getRequiredDatabaseDdlProvider } from '../core/connectionFactory';
import type { ConnectionDetails } from '../types';
import { ColumnTypeChooser } from '../dialects/netezza/import/typeMapping';
import { formatQualifiedObjectName } from '../utils/identifierUtils';
import { classifySqlTypeFamily } from './typeTranslation/classifySqlType';
import { parseSqlType } from './typeTranslation/parseSqlType';
import { createMigrationProgress } from './progress';
import { closeSourceConnection, formatSourceCellValue, openSourceRowSet, type MigrationSourceConnection, type SourceColumnDescriptor } from './rowSource';
import { buildCreateTableDdl, buildTargetQualifiedName, normalizeTargetIdentifierCase, sanitizeDefaultValue } from './ddlBuilder';
import { renderTargetType, toCanonicalType } from './typeTranslation/translateType';
import { writeToTarget, type PreparedTargetColumn } from './targetWriter';
import { normalizeMigrationSourceSql, wrapMigrationSourceSql } from './sourceSql';
import type {
    MigrationColumnMapping,
    MigrationPlan,
    MigrationProgressCallback,
    MigrationRequest,
    MigrationResult,
    MigrationSourceContext,
} from './types';

export interface MigrationConnectionLookup {
    getConnection(name: string): Promise<ConnectionDetails | undefined>;
    getConnectionDatabaseKind(name?: string): DatabaseKind | undefined;
}

export interface MigrationServiceDependencies {
    connectionManager: MigrationConnectionLookup;
}

const DEFAULT_SAMPLE_SIZE = 100;
const DEFAULT_REPORT_EVERY_ROWS = 5000;

export class MigrationService {
    constructor(private readonly dependencies: MigrationServiceDependencies) {}

    private async getConnectionDetails(connectionName: string): Promise<ConnectionDetails> {
        const details = await this.dependencies.connectionManager.getConnection(connectionName);
        if (!details) {
            throw new Error(`Connection "${connectionName}" is not configured.`);
        }
        return details;
    }

    /**
     * Runs `SELECT COUNT(*)` on the source for the progress forecast.
     * Returns undefined when the count cannot be computed.
     */
    public async countSourceRows(
        request: MigrationRequest,
        context: MigrationSourceContext,
        progressCallback?: MigrationProgressCallback,
    ): Promise<number | undefined> {
        const startedAt = Date.now();
        const countSql = request.source.mode === 'table'
            ? `SELECT COUNT(*) FROM ${context.qualifiedTableName}`
            : wrapMigrationSourceSql(request.source.sql, context.kind, 'SELECT COUNT(*)');

        progressCallback?.(createMigrationProgress('count', 0, undefined, 'Counting source rows...', startedAt));

        const { createConnectedDatabaseConnectionFromDetails } = await import('../core/connectionFactory');
        const connection = await createConnectedDatabaseConnectionFromDetails(context.connectionDetails);
        try {
            const command = connection.createCommand(countSql);
            command.commandTimeout = 3600;
            const reader = await command.executeReader();
            try {
                if (await reader.read()) {
                    const value = reader.getValue(0);
                    const count = typeof value === 'number' ? value : Number(String(value ?? ''));
                    if (Number.isFinite(count)) {
                        return Math.floor(count);
                    }
                }
                return undefined;
            } finally {
                await reader.close();
            }
        } finally {
            await connection.close().catch(() => undefined);
        }
    }

    /**
     * Analyzes the source and resolves the column list.
     */
    public async analyzeSource(
        request: MigrationRequest,
        progressCallback?: MigrationProgressCallback,
    ): Promise<{
        sourceContext: MigrationSourceContext;
        columns: SourceColumnDescriptor[];
        pkColumns: string[];
        warnings: string[];
        sampleCells?: string[][];
    }> {
        const startedAt = Date.now();
        const sourceDetails = await this.getConnectionDetails(request.source.connectionName);
        const sourceKind = this.resolveKind(sourceDetails);

        if (request.source.mode === 'table') {
            return this.analyzeSourceTable(request, sourceDetails, sourceKind, startedAt, progressCallback);
        }
        return this.analyzeSourceSql(request, sourceDetails, sourceKind, startedAt, progressCallback);
    }

    private resolveKind(details: ConnectionDetails): DatabaseKind {
        return tryNormalizeDatabaseKind(details.dbType) ?? 'netezza';
    }

    private async analyzeSourceTable(
        request: MigrationRequest,
        sourceDetails: ConnectionDetails,
        sourceKind: DatabaseKind,
        startedAt: number,
        progressCallback?: MigrationProgressCallback,
    ): Promise<{
        sourceContext: MigrationSourceContext;
        columns: SourceColumnDescriptor[];
        pkColumns: string[];
        warnings: string[];
        sampleCells?: string[][];
    }> {
        const selection = request.source;
        if (selection.mode !== 'table') {
            throw new Error('Internal error: expected table source mode.');
        }

        const { createConnectedDatabaseConnectionFromDetails } = await import('../core/connectionFactory');
        const connection = await createConnectedDatabaseConnectionFromDetails(sourceDetails);
        const qualifiedTableName = formatQualifiedObjectName(
            selection.database,
            selection.schema,
            selection.table,
            sourceKind,
        );

        try {
            progressCallback?.(createMigrationProgress('count', 0, undefined, 'Reading source table metadata...', startedAt));

            const ddlProvider = getRequiredDatabaseDdlProvider(sourceKind);
            const columnInfos = await ddlProvider.getColumns(
                connection,
                selection.database ?? '',
                selection.schema ?? '',
                selection.table,
            );

            let pkColumns: string[] = [];
            try {
                const keys = await ddlProvider.getKeysInfo(
                    connection,
                    selection.database ?? '',
                    selection.schema ?? '',
                    selection.table,
                );
                for (const key of keys.values()) {
                    if (key.type.toUpperCase() === 'PRIMARY KEY' || key.typeChar?.toUpperCase() === 'P') {
                        pkColumns = key.columns;
                        break;
                    }
                }
            } catch {
                // PK metadata is best-effort; proceed without it.
            }

            const columns: SourceColumnDescriptor[] = columnInfos.map((info, index) => ({
                index,
                name: info.name,
                driverType: info.fullTypeName || info.name,
                notNull: info.notNull,
                defaultValue: info.defaultValue ?? undefined,
            }));

            return {
                sourceContext: { kind: sourceKind, connectionDetails: sourceDetails, qualifiedTableName },
                columns,
                pkColumns,
                warnings: [],
            };
        } finally {
            await connection.close().catch(() => undefined);
        }
    }

    private async analyzeSourceSql(
        request: MigrationRequest,
        sourceDetails: ConnectionDetails,
        sourceKind: DatabaseKind,
        startedAt: number,
        progressCallback?: MigrationProgressCallback,
    ): Promise<{
        sourceContext: MigrationSourceContext;
        columns: SourceColumnDescriptor[];
        pkColumns: string[];
        warnings: string[];
        sampleCells?: string[][];
    }> {
        const selection = request.source;
        if (selection.mode !== 'sql') {
            throw new Error('Internal error: expected SQL source mode.');
        }

        const sampleSize = Math.max(0, Math.floor(request.sampleSize ?? DEFAULT_SAMPLE_SIZE));
        const sourceSql = normalizeMigrationSourceSql(selection.sql);

        progressCallback?.(createMigrationProgress('count', 0, undefined, 'Analyzing source query metadata...', startedAt));

        const { createConnectedDatabaseConnectionFromDetails } = await import('../core/connectionFactory');
        const connection = await createConnectedDatabaseConnectionFromDetails(sourceDetails);
        try {
            const command = connection.createCommand(sourceSql);
            command.commandTimeout = 3600;
            const reader = await command.executeReader();
            try {
                const { getEffectiveResultColumnType } = await import('../core/streaming/resultColumnMetadata');
                let fieldCount = reader.fieldCount;
                let hasFirstRow = false;

                const readColumns = (): { columns: SourceColumnDescriptor[]; driverTypes: string[] } => {
                    fieldCount = reader.fieldCount;
                    const columnNames = Array.from({ length: fieldCount }, (_value, index) => {
                        try {
                            return reader.getName(index) || `COL_${index}`;
                        } catch {
                            return `COL_${index}`;
                        }
                    });
                    const driverTypes = columnNames.map((_name, index) => {
                        try {
                            return getEffectiveResultColumnType(reader as never, index) ?? '';
                        } catch {
                            return '';
                        }
                    });
                    const columns: SourceColumnDescriptor[] = columnNames.map((name, index) => ({
                        index,
                        name,
                        driverType: driverTypes[index],
                        requiresValueSampling: requiresValueSampling(driverTypes[index]),
                    }));
                    return { columns, driverTypes };
                };

                let { columns, driverTypes } = readColumns();

                // Most adapters, including Oracle, expose result metadata as soon
                // as executeReader() completes. Keep one compatibility probe for
                // drivers which populate field metadata only after the first read.
                if (fieldCount === 0 || columns.some(column => !column.driverType)) {
                    hasFirstRow = await reader.read();
                    ({ columns, driverTypes } = readColumns());
                }

                const sampledColumns = columns.filter(column => column.requiresValueSampling);
                const sampleCells: string[][] | undefined = sampledColumns.length > 0 ? [] : undefined;

                if (sampleCells && sampleSize > 0) {
                    if (!hasFirstRow) {
                        hasFirstRow = await reader.read();
                    }

                    let rowsRead = 0;
                    if (hasFirstRow) {
                        sampleCells.push(Array.from({ length: fieldCount }, (_value, index) =>
                            formatSourceCellValue(reader.getValue(index), driverTypes[index]),
                        ));
                        rowsRead = 1;
                    }

                    while (rowsRead < sampleSize && await reader.read()) {
                        sampleCells.push(Array.from({ length: fieldCount }, (_value, index) =>
                            formatSourceCellValue(reader.getValue(index), driverTypes[index]),
                        ));
                        rowsRead++;
                    }
                }

                const warnings: string[] = [];
                for (const column of sampledColumns) {
                    warnings.push(
                        `Column "${column.name}" reports an incomplete or generic type ("${column.driverType || 'unknown'}"); up to ${sampleSize} source rows may be used for refinement.`,
                    );
                }

                return {
                    sourceContext: { kind: sourceKind, connectionDetails: sourceDetails },
                    columns,
                    pkColumns: [],
                    warnings,
                    sampleCells,
                };
            } finally {
                await reader.close().catch(() => undefined);
            }
        } finally {
            await connection.close().catch(() => undefined);
        }
    }

    /**
     * Builds the migration plan: type translation + DDL + column mapping.
     */
    public buildPlan(
        request: MigrationRequest,
        sourceContext: MigrationSourceContext,
        columns: SourceColumnDescriptor[],
        pkColumns: string[],
        analysisWarnings: string[],
        sampleCells?: string[][],
    ): MigrationPlan {
        const { connectionManager } = this.dependencies;
        const targetKind = connectionManager.getConnectionDatabaseKind(request.target.connectionName) ?? 'netezza';
        const warnings = [...analysisWarnings];
        const mapping: MigrationColumnMapping[] = columns.map((column) => {
            const sourceType = column.driverType || 'NVARCHAR(255)';
            let effectiveType = sourceType;
            const columnIndex = column.index;

            if (sampleCells && column.requiresValueSampling) {
                const chooser = new ColumnTypeChooser('.', { inferBoolean: true });
                let hasSampleValue = false;
                for (const cell of sampleCells) {
                    const value = cell[columnIndex];
                    if (value) {
                        hasSampleValue = true;
                        chooser.refreshCurrentType(value);
                    }
                }
                if (hasSampleValue) {
                    effectiveType = chooser.currentType.toString();
                }
            }

            const canonical = toCanonicalType(effectiveType);
            const rendered = renderTargetType(targetKind, canonical.type);
            warnings.push(...canonical.warnings, ...rendered.warnings);

            const sanitizedDefault = sanitizeDefaultValue(column.defaultValue);
            if (column.defaultValue && !sanitizedDefault) {
                warnings.push(
                    `Default value "${column.defaultValue}" of column "${column.name}" is not portable and was skipped.`,
                );
            }

            return {
                sourceIndex: columnIndex,
                sourceName: column.name,
                sourceType,
                targetType: canonical.type,
                targetTypeDisplay: rendered.type,
                targetName: normalizeTargetIdentifierCase(column.name, targetKind),
                notNull: column.notNull ?? false,
                isPk: pkColumns.includes(column.name),
                defaultValue: sanitizedDefault,
            };
        });

        const qualifiedName = buildTargetQualifiedName(
            request.target.database,
            request.target.schema,
            request.target.table,
            targetKind,
        );

        const createTableDdl = buildCreateTableDdl(targetKind, qualifiedName, mapping.map(column => ({
            name: column.targetName,
            type: column.targetTypeDisplay,
            notNull: column.notNull,
            isPk: column.isPk,
            defaultValue: column.defaultValue,
        })));

        return {
            sourceKind: sourceContext.kind,
            targetKind,
            sourceMode: request.source.mode,
            columns: mapping,
            createTableDdl,
            warnings: [...new Set(warnings)],
            targetQualifiedName: qualifiedName,
        };
    }

    /**
     * Executes the migration. The caller is responsible for connecting the
     * source connection and providing the row iterator.
     */
    public async execute(
        request: MigrationRequest,
        plan: MigrationPlan,
        sourceContext: MigrationSourceContext,
        progressCallback?: MigrationProgressCallback,
        options?: { customCreateTableDdl?: string; streamBatchSize?: number },
    ): Promise<MigrationResult> {
        const startedAt = Date.now();
        const targetDetails = await this.getConnectionDetails(request.target.connectionName);

        const totalRows = plan.totalRows;

        progressCallback?.(createMigrationProgress('stream', 0, totalRows, 'Starting row transfer...', startedAt));

        const { createConnectedDatabaseConnectionFromDetails } = await import('../core/connectionFactory');
        const sourceConnection = await createConnectedDatabaseConnectionFromDetails(sourceContext.connectionDetails);
        const source: MigrationSourceConnection = {
            context: sourceContext,
            connection: sourceConnection,
        };

        try {
            const sourceSql = request.source.mode === 'table'
                ? `SELECT * FROM ${sourceContext.qualifiedTableName}`
                : normalizeMigrationSourceSql(request.source.sql);

            const rowSet = await openSourceRowSet(sourceConnection, sourceSql, {
                progressCallback,
                startedAt,
                totalRows,
                reportEveryRows: DEFAULT_REPORT_EVERY_ROWS,
            });

            const preparedColumns: PreparedTargetColumn[] = plan.columns.map(column => ({
                sourceIndex: column.sourceIndex,
                targetName: column.targetName,
                canonicalType: column.targetType,
                renderedType: column.targetTypeDisplay,
                notNull: column.notNull,
                isPk: column.isPk,
                defaultValue: column.defaultValue,
            }));

            const writeResult = await writeToTarget({
                targetKind: plan.targetKind,
                target: request.target,
                targetDetails,
                columns: preparedColumns,
                customCreateTableDdl: options?.customCreateTableDdl,
                streamBatchSize: options?.streamBatchSize,
                rows: rowSet.rows(),
                totalRows,
                startedAt,
                progressCallback: progressCallback ?? (() => undefined),
            });

            progressCallback?.(createMigrationProgress(
                'done',
                writeResult.rowsInserted,
                totalRows,
                `Migration finished: ${writeResult.rowsInserted.toLocaleString()} rows`,
                startedAt,
            ));

            return {
                success: true,
                message: writeResult.planOnly
                    ? 'Migration plan generated (Snowflake does not support direct load).'
                    : `Migration completed: ${writeResult.rowsInserted.toLocaleString()} rows inserted.`,
                rowsInserted: writeResult.rowsInserted,
                elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
                warnings: plan.warnings,
                plan,
            };
        } catch (error: unknown) {
            progressCallback?.(createMigrationProgress(
                'error',
                0,
                totalRows,
                error instanceof Error ? error.message : String(error),
                startedAt,
            ));
            return {
                success: false,
                message: error instanceof Error ? error.message : String(error),
                rowsInserted: 0,
                elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
                warnings: plan.warnings,
                plan,
            };
        } finally {
            await closeSourceConnection(source);
        }
    }
}

function requiresValueSampling(typeName: string): boolean {
    const normalized = typeName.trim().toUpperCase();
    if (!normalized) {
        return true;
    }

    const parsed = parseSqlType(normalized);
    const family = classifySqlTypeFamily(parsed);
    switch (family) {
        case 'decimal':
            return parsed.precision === undefined;
        case 'char':
        case 'varchar':
        case 'nvarchar':
        case 'binary':
            return parsed.length === undefined;
        case 'unknown':
            return true;
        default:
            return false;
    }
}
