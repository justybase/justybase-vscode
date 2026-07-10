import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ColumnDefinition } from '../../types';
import { getLogger } from '../../utils/logger';
import { buildDiskQuery } from './diskQueryBuilder';
import { mapColumnTypeToSqlite, sqliteColumnName } from './netezzaToSqliteType';
import { isTemporalColumnType, normalizeTemporalCellValue } from './temporalColumnTypes';
import { loadNodeSqliteModule } from './sqliteModuleLoader';
import type {
    DiskAggregationRequest,
    DiskAggregationResult,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskGroupRow,
    DiskQuerySpec,
    IResultRowSource,
    RowRange,
} from './types';

type SqlInputValue = import('node:sqlite').SQLInputValue;
type StatementSync = import('node:sqlite').StatementSync;

const BULK_INSERT_PRAGMAS = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = OFF',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA cache_size = -131072',
    'PRAGMA locking_mode = EXCLUSIVE',
];

const READ_OPTIMIZED_PRAGMAS = [
    'PRAGMA synchronous = NORMAL',
    'PRAGMA locking_mode = NORMAL',
];

function asSqlParams(params: unknown[]): SqlInputValue[] {
    return params as SqlInputValue[];
}

function normalizeCellValue(value: unknown, dataType?: string): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (isTemporalColumnType(dataType)) {
        return normalizeTemporalCellValue(value, dataType);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    return value;
}

function normalizeSqliteResultValue(value: unknown): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'bigint') {
        if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return Number(value);
        }
        return value.toString();
    }
    return value;
}

function normalizeSqliteResultRow(row: unknown[]): unknown[] {
    return row.map((value) => normalizeSqliteResultValue(value));
}

function normalizeSqliteResultRows(rows: unknown[][]): unknown[][] {
    return rows.map((row) => normalizeSqliteResultRow(row));
}

function normalizeSqliteRecord(row: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
        normalized[key] = normalizeSqliteResultValue(value);
    }
    return normalized;
}

function normalizeSqliteRecords(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.map((row) => normalizeSqliteRecord(row));
}

function prepareValueReadStatement(statement: StatementSync): StatementSync {
    statement.setReadBigInts(true);
    return statement;
}

function isNilGroupValue(value: unknown): boolean {
    return value === null || value === undefined;
}

export class SqliteResultStore implements IResultRowSource {
    public readonly id: string;
    public readonly dbPath: string;
    public readonly columnCount: number;

    private readonly _database: import('node:sqlite').DatabaseSync;
    private readonly _columnNames: string;
    private readonly _columnTypes: Array<string | undefined>;
    private readonly _insertSql: string;
    private readonly _selectSql: string;
    private readonly _insertBatchSize: number;
    private _totalRows = 0;
    private _disposed = false;
    private _bulkInsertMode = true;

    private constructor(
        id: string,
        dbPath: string,
        database: import('node:sqlite').DatabaseSync,
        columns: ColumnDefinition[],
        insertBatchSize: number,
    ) {
        this.id = id;
        this.dbPath = dbPath;
        this._database = database;
        this.columnCount = columns.length;
        this._insertBatchSize = insertBatchSize;
        this._columnTypes = columns.map((col) => col.type);

        const colDefs = columns.map((col, index) =>
            `"${sqliteColumnName(index)}" ${mapColumnTypeToSqlite(col.type)}`
        );
        const colNames = columns.map((_col, index) => `"${sqliteColumnName(index)}"`).join(', ');
        this._columnNames = colNames;
        const placeholders = columns.map(() => '?').join(', ');

        database.exec(`
            CREATE TABLE result_rows (
                _rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                ${colDefs.join(',\n                ')}
            );
        `);

        this._insertSql = `INSERT INTO result_rows (${colNames}) VALUES (${placeholders})`;
        this._selectSql = `SELECT ${colNames} FROM result_rows ORDER BY _rowid LIMIT ? OFFSET ?`;
    }

    public static create(
        columns: ColumnDefinition[],
        insertBatchSize: number,
        dbPath?: string,
    ): SqliteResultStore {
        const id = randomUUID();
        const resolvedPath = dbPath ?? path.join(os.tmpdir(), `justybase-results-${id}.db`);
        const { DatabaseSync } = loadNodeSqliteModule();
        const database = new DatabaseSync(resolvedPath);
        const store = new SqliteResultStore(id, resolvedPath, database, columns, insertBatchSize);
        store.applyBulkInsertPragmas();
        return store;
    }

    public insertRows(rows: unknown[][]): void {
        this.assertNotDisposed();
        if (rows.length === 0) {
            return;
        }

        const insert = this._database.prepare(this._insertSql);
        const batchSize = this._insertBatchSize;

        for (let offset = 0; offset < rows.length; offset += batchSize) {
            const end = Math.min(offset + batchSize, rows.length);
            this._database.exec('BEGIN');
            try {
                for (let rowIndex = offset; rowIndex < end; rowIndex++) {
                    const row = rows[rowIndex] ?? [];
                    const values = new Array<unknown>(this.columnCount);
                    for (let colIndex = 0; colIndex < this.columnCount; colIndex++) {
                        values[colIndex] = normalizeCellValue(row[colIndex], this._columnTypes[colIndex]);
                    }
                    insert.run(...(values as import('node:sqlite').SQLInputValue[]));
                }
                this._database.exec('COMMIT');
            } catch (error) {
                try {
                    this._database.exec('ROLLBACK');
                } catch {
                    // ignore rollback failure
                }
                throw error;
            }
        }

        this._totalRows += rows.length;
    }

    /** Keep only the first `rowCount` rows (used when a streaming query is cancelled). */
    public truncateToRowCount(rowCount: number): void {
        this.assertNotDisposed();
        const target = Math.max(0, Math.floor(rowCount));
        if (target >= this._totalRows) {
            return;
        }

        if (target === 0) {
            this._database.exec('DELETE FROM result_rows');
            this._totalRows = 0;
            return;
        }

        const deleteStatement = this._database.prepare(`
            DELETE FROM result_rows
            WHERE _rowid NOT IN (
                SELECT _rowid FROM result_rows ORDER BY _rowid LIMIT ?
            )
        `);
        deleteStatement.run(target);
        this._totalRows = target;
    }

    /** Restore safer SQLite settings after bulk insert streaming completes. */
    public finalizeBulkInsert(): void {
        this.assertNotDisposed();
        if (!this._bulkInsertMode) {
            return;
        }
        this._bulkInsertMode = false;
        for (const pragma of READ_OPTIMIZED_PRAGMAS) {
            this._database.exec(pragma);
        }
    }

    public getTotalRows(): number {
        return this._totalRows;
    }

    public getRows(range: RowRange): unknown[][] {
        this.assertNotDisposed();
        const limit = Math.max(0, range.limit);
        const offset = Math.max(0, range.offset);
        if (limit === 0) {
            return [];
        }

        const statement = prepareValueReadStatement(this._database.prepare(this._selectSql));
        statement.setReturnArrays(true);
        const rows = statement.all(limit, offset) as unknown as unknown[][];
        return normalizeSqliteResultRows(rows);
    }

    public queryRows(spec: DiskQuerySpec | undefined, range: RowRange): unknown[][] {
        this.assertNotDisposed();
        const limit = Math.max(0, range.limit);
        const offset = Math.max(0, range.offset);
        if (limit === 0) {
            return [];
        }

        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const whereClause = built.whereSql ? ` WHERE ${built.whereSql}` : '';
        const sql = `SELECT ${this._columnNames} FROM result_rows${whereClause} ORDER BY ${built.orderBySql} LIMIT ? OFFSET ?`;
        const statement = prepareValueReadStatement(this._database.prepare(sql));
        statement.setReturnArrays(true);
        const rows = statement.all(...asSqlParams(built.whereParams), limit, offset) as unknown as unknown[][];
        return normalizeSqliteResultRows(rows);
    }

    public countRows(spec: DiskQuerySpec | undefined): number {
        this.assertNotDisposed();
        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const whereClause = built.whereSql ? ` WHERE ${built.whereSql}` : '';
        const sql = `SELECT COUNT(*) AS cnt FROM result_rows${whereClause}`;
        const statement = this._database.prepare(sql);
        const row = statement.get(...asSqlParams(built.whereParams)) as { cnt?: number } | undefined;
        return typeof row?.cnt === 'number' ? row.cnt : Number(row?.cnt ?? 0);
    }

    public distinctValues(
        spec: DiskQuerySpec | undefined,
        columnIndex: number,
        limit: number,
    ): { values: DiskDistinctValue[]; truncated: boolean } {
        this.assertNotDisposed();
        if (columnIndex < 0 || columnIndex >= this.columnCount) {
            return { values: [], truncated: false };
        }

        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const whereClause = built.whereSql ? ` WHERE ${built.whereSql}` : '';
        const col = `"${sqliteColumnName(columnIndex)}"`;
        const sql = `
            SELECT ${col} AS value, COUNT(*) AS cnt
            FROM result_rows${whereClause}
            GROUP BY ${col}
            ORDER BY ${col} COLLATE NOCASE
            LIMIT ?
        `;
        const statement = prepareValueReadStatement(this._database.prepare(sql));
        const rows = normalizeSqliteRecords(
            statement.all(...asSqlParams(built.whereParams), limit + 1) as Array<Record<string, unknown>>,
        );
        const truncated = rows.length > limit;
        const slice = truncated ? rows.slice(0, limit) : rows;
        return {
            values: slice.map((row) => ({
                raw: row.value ?? null,
                count: typeof row.cnt === 'number' ? row.cnt : Number(row.cnt ?? 0),
            })),
            truncated,
        };
    }

    public aggregateRows(
        spec: DiskQuerySpec | undefined,
        requests: DiskAggregationRequest[],
    ): DiskAggregationResult[] {
        this.assertNotDisposed();
        if (requests.length === 0) {
            return [];
        }

        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const whereClause = built.whereSql ? ` WHERE ${built.whereSql}` : '';
        const selectParts: string[] = [];
        for (const request of requests) {
            const col = `"${sqliteColumnName(request.columnIndex)}"`;
            switch (request.fn) {
                case 'sum':
                    selectParts.push(`SUM(${col}) AS agg_${request.columnIndex}_sum`);
                    break;
                case 'avg':
                    selectParts.push(`AVG(${col}) AS agg_${request.columnIndex}_avg`);
                    break;
                case 'min':
                    selectParts.push(`MIN(${col}) AS agg_${request.columnIndex}_min`);
                    break;
                case 'max':
                    selectParts.push(`MAX(${col}) AS agg_${request.columnIndex}_max`);
                    break;
                case 'count':
                    selectParts.push(`COUNT(${col}) AS agg_${request.columnIndex}_count`);
                    break;
                case 'countDistinct':
                    selectParts.push(`COUNT(DISTINCT ${col}) AS agg_${request.columnIndex}_countDistinct`);
                    break;
                case 'stdev': {
                    const meanExpr = `AVG(${col})`;
                    selectParts.push(
                        `CASE WHEN COUNT(${col}) >= 1 THEN `
                        + `SQRT(MAX(0.0, AVG((${col}) * (${col})) - (${meanExpr}) * (${meanExpr}))) `
                        + `ELSE NULL END AS agg_${request.columnIndex}_stdev`,
                    );
                    break;
                }
                case 'median':
                    break;
                default:
                    break;
            }
        }

        let row: Record<string, unknown> | undefined;
        if (selectParts.length > 0) {
            const sql = `SELECT ${selectParts.join(', ')} FROM result_rows${whereClause}`;
            const statement = prepareValueReadStatement(this._database.prepare(sql));
            const rawRow = statement.get(...asSqlParams(built.whereParams)) as Record<string, unknown> | undefined;
            row = rawRow ? normalizeSqliteRecord(rawRow) : undefined;
        }

        const results: DiskAggregationResult[] = [];
        if (row) {
            for (const request of requests) {
                const key = `agg_${request.columnIndex}_${request.fn}`;
                if (!(key in row)) {
                    continue;
                }
                results.push({
                    columnIndex: request.columnIndex,
                    fn: request.fn,
                    value: row[key] ?? null,
                });
            }
        }
        for (const request of requests) {
            if (request.fn !== 'median' || !this.isValidColumnIndex(request.columnIndex)) {
                continue;
            }
            results.push({
                columnIndex: request.columnIndex,
                fn: request.fn,
                value: this.queryMedianForWhere(
                    `"${sqliteColumnName(request.columnIndex)}"`,
                    { sql: built.whereSql, params: built.whereParams },
                ),
            });
        }
        return results;
    }

    public queryGroups(
        spec: DiskQuerySpec | undefined,
        grouping: DiskGroupLevel[],
        pathItems: DiskGroupPathItem[],
        range: RowRange,
        aggregationRequests: DiskAggregationRequest[] = [],
    ): DiskGroupQueryResult {
        this.assertNotDisposed();
        const validGrouping = grouping.filter((level) => this.isValidColumnIndex(level.columnIndex));
        const validPath = pathItems.filter((item) => this.isValidColumnIndex(item.columnIndex));
        const depth = validPath.length;
        const limit = Math.max(0, range.limit);
        const offset = Math.max(0, range.offset);

        if (depth >= validGrouping.length) {
            return this.queryGroupedLeafRows(spec, validPath, { offset, limit }, aggregationRequests);
        }

        if (limit === 0) {
            return {
                kind: 'groups',
                path: validPath,
                depth,
                totalCount: this.countGroups(spec, validPath, validGrouping[depth].columnIndex),
                groups: [],
            };
        }

        const groupColumnIndex = validGrouping[depth].columnIndex;
        const groupColumn = `"${sqliteColumnName(groupColumnIndex)}"`;
        const where = this.buildGroupedWhere(spec, validPath);
        const whereClause = where.sql ? ` WHERE ${where.sql}` : '';
        const aggregationSelectParts = this.buildAggregationSelectParts(aggregationRequests);
        const selectAggregations = aggregationSelectParts.length > 0
            ? `, ${aggregationSelectParts.join(', ')}`
            : '';
        const sql = `
            SELECT ${groupColumn} AS group_value, COUNT(*) AS row_count${selectAggregations}
            FROM result_rows${whereClause}
            GROUP BY ${groupColumn}
            ORDER BY ${this.buildGroupOrderBy(spec, groupColumnIndex)}
            LIMIT ? OFFSET ?
        `;
        const statement = prepareValueReadStatement(this._database.prepare(sql));
        const rows = normalizeSqliteRecords(
            statement.all(...asSqlParams(where.params), limit, offset) as Array<Record<string, unknown>>,
        );
        const totalCount = this.countGroups(spec, validPath, groupColumnIndex);
        const groups: DiskGroupRow[] = rows.map((row) => {
            const value = row.group_value ?? null;
            const nextPath = [...validPath, { columnIndex: groupColumnIndex, value }];
            return {
                kind: 'group',
                columnIndex: groupColumnIndex,
                depth,
                value,
                count: Number(row.row_count ?? 0),
                path: nextPath,
                hasChildren: Number(row.row_count ?? 0) > 0,
                aggregations: this.extractAggregationResults(row, aggregationRequests),
            };
        });

        return {
            kind: 'groups',
            path: validPath,
            depth,
            totalCount,
            groups,
        };
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        try {
            this._database.close();
        } catch (error) {
            getLogger().warn(`Failed to close SQLite result store ${this.id}: ${error}`);
        }

        this.removeTempDbFiles();
    }

    private applyBulkInsertPragmas(): void {
        for (const pragma of BULK_INSERT_PRAGMAS) {
            this._database.exec(pragma);
        }
    }

    private isValidColumnIndex(columnIndex: number): boolean {
        return Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < this.columnCount;
    }

    private buildGroupedWhere(
        spec: DiskQuerySpec | undefined,
        pathItems: DiskGroupPathItem[],
    ): { sql: string; params: unknown[] } {
        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const whereParts: string[] = [];
        const params = [...built.whereParams];
        if (built.whereSql) {
            whereParts.push(`(${built.whereSql})`);
        }
        for (const item of pathItems) {
            if (!this.isValidColumnIndex(item.columnIndex)) {
                continue;
            }
            const col = `"${sqliteColumnName(item.columnIndex)}"`;
            if (isNilGroupValue(item.value)) {
                whereParts.push(`${col} IS NULL`);
            } else {
                whereParts.push(`${col} = ?`);
                params.push(item.value);
            }
        }
        return {
            sql: whereParts.join(' AND '),
            params,
        };
    }

    private buildGroupOrderBy(spec: DiskQuerySpec | undefined, columnIndex: number): string {
        const direction = spec?.sorting?.find((sort) => sort.columnIndex === columnIndex)?.desc ? 'DESC' : 'ASC';
        const col = `"${sqliteColumnName(columnIndex)}"`;
        const columnType = this._columnTypes[columnIndex];
        const isNumeric = mapColumnTypeToSqlite(columnType) === 'INTEGER'
            || mapColumnTypeToSqlite(columnType) === 'REAL';
        if (isNumeric || isTemporalColumnType(columnType)) {
            return `${col} ${direction}`;
        }
        return `${col} COLLATE NOCASE ${direction}`;
    }

    private buildAggregationSelectParts(requests: DiskAggregationRequest[]): string[] {
        const selectParts: string[] = [];
        for (const request of requests) {
            if (!this.isValidColumnIndex(request.columnIndex)) {
                continue;
            }
            const col = `"${sqliteColumnName(request.columnIndex)}"`;
            switch (request.fn) {
                case 'sum':
                    selectParts.push(`SUM(${col}) AS agg_${request.columnIndex}_sum`);
                    break;
                case 'avg':
                    selectParts.push(`AVG(${col}) AS agg_${request.columnIndex}_avg`);
                    break;
                case 'min':
                    selectParts.push(`MIN(${col}) AS agg_${request.columnIndex}_min`);
                    break;
                case 'max':
                    selectParts.push(`MAX(${col}) AS agg_${request.columnIndex}_max`);
                    break;
                case 'count':
                    selectParts.push(`COUNT(${col}) AS agg_${request.columnIndex}_count`);
                    break;
                case 'countDistinct':
                    selectParts.push(`COUNT(DISTINCT ${col}) AS agg_${request.columnIndex}_countDistinct`);
                    break;
                case 'stdev': {
                    const meanExpr = `AVG(${col})`;
                    selectParts.push(
                        `CASE WHEN COUNT(${col}) >= 1 THEN `
                        + `SQRT(MAX(0.0, AVG((${col}) * (${col})) - (${meanExpr}) * (${meanExpr}))) `
                        + `ELSE NULL END AS agg_${request.columnIndex}_stdev`,
                    );
                    break;
                }
                case 'median':
                    break;
                default:
                    break;
            }
        }
        return selectParts;
    }

    private extractAggregationResults(
        row: Record<string, unknown>,
        requests: DiskAggregationRequest[],
    ): DiskAggregationResult[] {
        const results: DiskAggregationResult[] = [];
        for (const request of requests) {
            const key = `agg_${request.columnIndex}_${request.fn}`;
            if (!(key in row)) {
                continue;
            }
            results.push({
                columnIndex: request.columnIndex,
                fn: request.fn,
                value: row[key] ?? null,
            });
        }
        return results;
    }

    private countGroups(
        spec: DiskQuerySpec | undefined,
        pathItems: DiskGroupPathItem[],
        columnIndex: number,
    ): number {
        if (!this.isValidColumnIndex(columnIndex)) {
            return 0;
        }
        const groupColumn = `"${sqliteColumnName(columnIndex)}"`;
        const where = this.buildGroupedWhere(spec, pathItems);
        const whereClause = where.sql ? ` WHERE ${where.sql}` : '';
        const sql = `
            SELECT COUNT(*) AS cnt
            FROM (
                SELECT 1
                FROM result_rows${whereClause}
                GROUP BY ${groupColumn}
            )
        `;
        const statement = this._database.prepare(sql);
        const row = statement.get(...asSqlParams(where.params)) as { cnt?: number } | undefined;
        return typeof row?.cnt === 'number' ? row.cnt : Number(row?.cnt ?? 0);
    }

    private queryGroupedLeafRows(
        spec: DiskQuerySpec | undefined,
        pathItems: DiskGroupPathItem[],
        range: RowRange,
        aggregationRequests: DiskAggregationRequest[],
    ): DiskGroupQueryResult {
        const limit = Math.max(0, range.limit);
        const offset = Math.max(0, range.offset);
        const where = this.buildGroupedWhere(spec, pathItems);
        const whereClause = where.sql ? ` WHERE ${where.sql}` : '';
        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const countSql = `SELECT COUNT(*) AS cnt FROM result_rows${whereClause}`;
        const countStatement = this._database.prepare(countSql);
        const countRow = countStatement.get(...asSqlParams(where.params)) as { cnt?: number } | undefined;
        const totalCount = typeof countRow?.cnt === 'number' ? countRow.cnt : Number(countRow?.cnt ?? 0);

        const rows = limit === 0
            ? []
            : (() => {
                const sql = `SELECT ${this._columnNames} FROM result_rows${whereClause} ORDER BY ${built.orderBySql} LIMIT ? OFFSET ?`;
                const statement = prepareValueReadStatement(this._database.prepare(sql));
                statement.setReturnArrays(true);
                const leafRows = statement.all(...asSqlParams(where.params), limit, offset) as unknown as unknown[][];
                return normalizeSqliteResultRows(leafRows);
            })();

        return {
            kind: 'leafRows',
            path: pathItems,
            depth: pathItems.length,
            totalCount,
            rows,
            aggregations: this.aggregateRowsForWhere(where, aggregationRequests),
        };
    }

    private aggregateRowsForWhere(
        where: { sql: string; params: unknown[] },
        requests: DiskAggregationRequest[],
    ): DiskAggregationResult[] {
        const selectParts = this.buildAggregationSelectParts(requests);
        const results: DiskAggregationResult[] = [];
        if (selectParts.length > 0) {
            const whereClause = where.sql ? ` WHERE ${where.sql}` : '';
            const sql = `SELECT ${selectParts.join(', ')} FROM result_rows${whereClause}`;
            const statement = prepareValueReadStatement(this._database.prepare(sql));
            const rawRow = statement.get(...asSqlParams(where.params)) as Record<string, unknown> | undefined;
            const row = rawRow ? normalizeSqliteRecord(rawRow) : undefined;
            if (row) {
                results.push(...this.extractAggregationResults(row, requests));
            }
        }
        for (const request of requests) {
            if (request.fn !== 'median' || !this.isValidColumnIndex(request.columnIndex)) {
                continue;
            }
            results.push({
                columnIndex: request.columnIndex,
                fn: request.fn,
                value: this.queryMedianForWhere(`"${sqliteColumnName(request.columnIndex)}"`, where),
            });
        }
        return results;
    }

    private queryMedianForWhere(
        columnSql: string,
        where: { sql: string; params: unknown[] },
    ): unknown {
        const whereClause = where.sql ? ` WHERE ${where.sql} AND ${columnSql} IS NOT NULL` : ` WHERE ${columnSql} IS NOT NULL`;
        const sql = `
            WITH ordered AS (
                SELECT ${columnSql} AS value,
                       ROW_NUMBER() OVER (ORDER BY ${columnSql}) AS rn,
                       COUNT(*) OVER () AS cnt
                FROM result_rows${whereClause}
            )
            SELECT AVG(value) AS median_value
            FROM ordered
            WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
        `;
        const statement = prepareValueReadStatement(this._database.prepare(sql));
        const row = statement.get(...asSqlParams(where.params)) as { median_value?: unknown } | undefined;
        return row?.median_value ?? null;
    }

    private removeTempDbFiles(): void {
        const suffixes = ['', '-wal', '-shm', '-journal'];
        for (const suffix of suffixes) {
            const filePath = `${this.dbPath}${suffix}`;
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (error) {
                getLogger().warn(`Failed to delete SQLite result file ${filePath}: ${error}`);
            }
        }
    }

    private assertNotDisposed(): void {
        if (this._disposed) {
            throw new Error(`SqliteResultStore ${this.id} is disposed`);
        }
    }
}
