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
import { diskQuerySpecHasFilters } from './types';
import type {
    DiskAggregationRequest,
    DiskAggregationResult,
    DiskColumnGroupStats,
    DiskDistinctValue,
    DiskGroupLevel,
    DiskGroupPathItem,
    DiskGroupQueryResult,
    DiskGroupRow,
    DiskGroupStatsOmission,
    DiskGroupStatsRequest,
    DiskGroupStatsResult,
    DiskGroupStatsRow,
    DiskQuartiles,
    DiskQuerySpec,
    DiskTopValue,
    IResultRowSource,
    RowRange,
} from './types';

/** Group statistics: bounds keep a single SQL pass and its result set small enough for the host. */
const GROUP_STATS_MAX_GROUP_COLUMNS = 3;
const GROUP_STATS_MAX_STAT_COLUMNS = 8;
const GROUP_STATS_MAX_LIMIT = 1_000;
const GROUP_STATS_DEFAULT_TOP_LIMIT = 8;
const GROUP_STATS_MAX_TOP_LIMIT = 20;
/** Per-group top values are a cross-tab; it runs only up to these bounds. */
const GROUP_TOP_CROSS_TAB_MAX_GROUPS = 5_000;
const GROUP_TOP_CROSS_TAB_MAX_DISTINCT = 50;
/** Mirrors ANALYTICAL_CATEGORY_MAX_DISTINCT in the webview; a full distribution is kept only up to this size. */
const CATEGORY_MAX_DISTINCT = 50;
/** RARE_VALUE gates and limits, kept in step with the in-memory engine (analytical/types.ts). */
const RARE_MAX_OCCURRENCES = 3;
const RARE_MAX_EXAMPLES = 5;
const RARE_MIN_GROUPS = 3;
const RARE_MIN_DISTINCT = 3;
const RARE_MAX_DISTINCT = 10_000;
const RARE_MIN_NON_NULL = 100;
const RARE_MAX_DISTINCT_RATIO = 0.5;

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

/**
 * Zero-based ranks a type-7 quartile reads for a sample of n values, as SQL. Integer division on
 * integers is the floor used by the webview's quartileRanks; the pair (rank, rank + 1) covers interpolation.
 */
const QUARTILE_RANK_SQL = '(((n - 1) * 1) / 4, ((n - 1) * 1) / 4 + 1, ((n - 1) * 2) / 4, ((n - 1) * 2) / 4 + 1, ((n - 1) * 3) / 4, ((n - 1) * 3) / 4 + 1)';

interface QuartileRankRow {
    v: unknown;
    rn: unknown;
    n: unknown;
}

/**
 * Type-7 quartiles from rank rows. Mirrors media/resultPanel/analytical/quantiles.ts (quartilesFromRanks);
 * analyticalDiskEquivalence.test.ts pins both to the same numbers.
 */
function quartilesFromRankRows(rows: readonly QuartileRankRow[]): DiskQuartiles | undefined {
    if (rows.length === 0) {
        return undefined;
    }
    const n = asNumber(rows[0].n) ?? 0;
    const byRank = new Map<number, number>();
    for (const row of rows) {
        const rank = asNumber(row.rn);
        const value = asNumber(row.v);
        if (rank === null || value === null) {
            return undefined;
        }
        byRank.set(rank, value);
    }
    if (n <= 0) {
        return undefined;
    }
    const available = ([1, 2, 3] as const).every(quarter => {
        const numerator = (n - 1) * quarter;
        const lo = Math.floor(numerator / 4);
        return byRank.has(lo) && (numerator % 4 === 0 || byRank.has(lo + 1));
    });
    if (!available) {
        return undefined;
    }
    const at = (quarter: 1 | 2 | 3): number => {
        const numerator = (n - 1) * quarter;
        const lo = Math.floor(numerator / 4);
        const fraction = (numerator - 4 * lo) / 4;
        const below = byRank.get(lo) ?? Number.NaN;
        if (fraction === 0) {
            return below;
        }
        const above = byRank.get(lo + 1) ?? Number.NaN;
        return below + fraction * (above - below);
    };
    return { q1: at(1), median: at(2), q3: at(3) };
}

function quotedColumn(columnIndex: number): string {
    return `"${sqliteColumnName(columnIndex)}"`;
}

/**
 * SQL for a column with empty strings removed. The in-memory engine treats '' as null-like, so the store
 * must count, rank and aggregate the same way. NULLIF leaves stored numbers and blobs untouched.
 */
function nonNullValue(columnIndex: number): string {
    return `NULLIF(${quotedColumn(columnIndex)}, '')`;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampInteger(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Same key shape the webview uses, so host and client group identities agree. */
function groupValuesKey(values: readonly unknown[]): string {
    return JSON.stringify(values.map(value => (value === null || value === undefined ? null : String(value))));
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

    /**
     * Exact statistics per group over every spilled row. Population statistics use the same
     * single-pass moments as the groups, so client-side anomaly rules compare like with like.
     *
     * A request may carry a filter `spec` (the Analysis Document does this when the analysis scope
     * is "filtered rows"). The scope is applied by shadowing `result_rows` with a temporary copy of
     * the filtered rows for the duration of this synchronous call: every statistic below then sees
     * exactly the scoped population, including population moments, category counts and quartiles,
     * without threading a WHERE clause through each statement.
     */
    public queryGroupStats(request: DiskGroupStatsRequest): DiskGroupStatsResult {
        this.assertNotDisposed();
        if (diskQuerySpecHasFilters(request.spec)) {
            return this.runWithScopedRows(request.spec as DiskQuerySpec, () => this.queryGroupStatsUnscoped(request));
        }
        return this.queryGroupStatsUnscoped(request);
    }

    /**
     * Creates the scoped copy, shadows the spilled table, runs the statistics and always restores
     * the store. The scoped copy is a temporary table so the filters keep their bound parameters.
     */
    private runWithScopedRows<T>(spec: DiskQuerySpec, run: () => T): T {
        const built = buildDiskQuery(spec, this.columnCount, this._columnTypes);
        const whereClause = built.whereSql ? ` WHERE ${built.whereSql}` : '';
        this._database.exec('DROP TABLE IF EXISTS temp.justybase_scoped_rows');
        this._database.exec('DROP VIEW IF EXISTS temp.result_rows');
        const createScoped = this._database.prepare(
            `CREATE TEMP TABLE justybase_scoped_rows AS SELECT * FROM main.result_rows${whereClause}`,
        );
        createScoped.run(...asSqlParams(built.whereParams));
        this._database.exec('CREATE TEMP VIEW result_rows AS SELECT * FROM temp.justybase_scoped_rows');
        try {
            return run();
        } finally {
            this._database.exec('DROP VIEW IF EXISTS temp.result_rows');
            this._database.exec('DROP TABLE IF EXISTS temp.justybase_scoped_rows');
        }
    }

    private queryGroupStatsUnscoped(request: DiskGroupStatsRequest): DiskGroupStatsResult {
        const groupColumns = this.validColumnList(request.groupColumns, GROUP_STATS_MAX_GROUP_COLUMNS);
        const statColumns = this.validColumnList(request.statColumns, GROUP_STATS_MAX_STAT_COLUMNS, new Set(groupColumns));
        const limit = clampInteger(request.limit, 1, GROUP_STATS_MAX_LIMIT);
        const topLimit = clampInteger(request.topLimit ?? GROUP_STATS_DEFAULT_TOP_LIMIT, 1, GROUP_STATS_MAX_TOP_LIMIT);
        const requestedTop = this.validColumnList(request.topColumns ?? [], GROUP_STATS_MAX_STAT_COLUMNS)
            .filter(index => statColumns.includes(index));
        const topColumns = new Set(requestedTop);
        const omitted: DiskGroupStatsOmission[] = [];

        const totalRows = this.countAllRows();
        const population = this.queryPopulationStats(statColumns, topColumns, topLimit);
        if (groupColumns.length === 0) {
            return { groupColumns, totalRows, totalGroups: 0, groups: [], unlistedRows: 0, population };
        }

        const requestedQuantiles = this.validColumnList(request.quantileColumns ?? [], GROUP_STATS_MAX_STAT_COLUMNS)
            .filter(index => statColumns.includes(index));
        const quantileColumns = requestedQuantiles.filter(index => this.isNumericColumn(index));
        for (const columnIndex of requestedQuantiles) {
            // Numbers stored as text get no quartiles: the robust rules are skipped for the column on disk.
            if (!this.isNumericColumn(columnIndex)) {
                omitted.push({ columnIndex, field: 'quartiles', reason: 'not-numeric' });
            }
        }
        const requestedCategories = this.validColumnList(request.categoryColumns ?? [], GROUP_STATS_MAX_STAT_COLUMNS)
            .filter(index => statColumns.includes(index));
        const categoryColumns = requestedCategories.filter(index => this.hasFewDistinctValues(index, population));
        for (const columnIndex of requestedCategories) {
            if (!this.hasFewDistinctValues(columnIndex, population)) {
                omitted.push({ columnIndex, field: 'categories', reason: 'too-many-distinct' });
            }
        }
        for (const columnIndex of quantileColumns) {
            const stats = population.find(column => column.columnIndex === columnIndex);
            const quartiles = this.queryQuartiles(columnIndex);
            if (stats?.numeric && quartiles) {
                stats.numeric.quartiles = quartiles;
            }
        }
        for (const columnIndex of categoryColumns) {
            const stats = population.find(column => column.columnIndex === columnIndex);
            if (stats) {
                stats.categories = this.queryTopValues(columnIndex, CATEGORY_MAX_DISTINCT);
            }
        }

        const totalGroups = this.countGroupKeys(groupColumns);
        const { groups, listedRows } = this.queryGroupStatRows(groupColumns, statColumns, population, limit);
        if (quantileColumns.length > 0) {
            this.attachGroupQuartiles(groups, groupColumns, quantileColumns);
        }
        const crossTabColumns = [...topColumns].filter(index => {
            const stats = population.find(column => column.columnIndex === index);
            return stats !== undefined && stats.distinctCount <= GROUP_TOP_CROSS_TAB_MAX_DISTINCT;
        });
        for (const columnIndex of requestedTop) {
            const stats = population.find(column => column.columnIndex === columnIndex);
            if (stats !== undefined && stats.distinctCount > GROUP_TOP_CROSS_TAB_MAX_DISTINCT) {
                omitted.push({ columnIndex, field: 'topValues', reason: 'too-many-distinct' });
            }
        }
        const categoriesAttached = categoryColumns.length > 0 && totalGroups <= GROUP_TOP_CROSS_TAB_MAX_GROUPS;
        if (categoryColumns.length > 0 && totalGroups > GROUP_TOP_CROSS_TAB_MAX_GROUPS) {
            for (const columnIndex of categoryColumns) {
                omitted.push({ columnIndex, field: 'categories', reason: 'too-many-groups' });
            }
        }
        if (categoriesAttached) {
            this.attachGroupValueCounts(groups, groupColumns, categoryColumns, CATEGORY_MAX_DISTINCT, 'categories');
        }
        // A column with a full distribution already has its top values: the same ordering, cut to topLimit.
        const fromCategories = categoriesAttached ? crossTabColumns.filter(index => categoryColumns.includes(index)) : [];
        const counted = crossTabColumns.filter(index => !fromCategories.includes(index));
        for (const columnIndex of fromCategories) {
            for (const group of groups) {
                const stats = group.columns.find(column => column.columnIndex === columnIndex);
                if (stats) stats.topValues = (stats.categories ?? []).slice(0, topLimit);
            }
        }
        if (counted.length > 0) {
            if (totalGroups <= GROUP_TOP_CROSS_TAB_MAX_GROUPS) {
                this.attachGroupValueCounts(groups, groupColumns, counted, topLimit, 'topValues');
            } else {
                for (const columnIndex of counted) {
                    omitted.push({ columnIndex, field: 'topValues', reason: 'too-many-groups' });
                }
            }
        }
        const rareColumns = this.validColumnList(request.rareColumns ?? [], GROUP_STATS_MAX_STAT_COLUMNS)
            .filter(index => statColumns.includes(index) && this.isRareCandidate(index, population, totalGroups));
        if (rareColumns.length > 0) {
            this.attachGroupRareValues(groups, groupColumns, rareColumns);
        }

        return {
            groupColumns,
            totalRows,
            totalGroups,
            groups,
            unlistedRows: Math.max(0, totalRows - listedRows),
            population,
            ...(omitted.length > 0 ? { omitted } : {}),
        };
    }

    private validColumnList(indexes: readonly number[], max: number, exclude: ReadonlySet<number> = new Set()): number[] {
        const seen = new Set<number>();
        const result: number[] = [];
        for (const index of indexes) {
            if (!this.isValidColumnIndex(index) || exclude.has(index) || seen.has(index)) {
                continue;
            }
            seen.add(index);
            result.push(index);
            if (result.length >= max) {
                break;
            }
        }
        return result;
    }

    private hasFewDistinctValues(columnIndex: number, population: readonly DiskColumnGroupStats[]): boolean {
        const stats = population.find(column => column.columnIndex === columnIndex);
        return stats !== undefined && stats.distinctCount <= CATEGORY_MAX_DISTINCT;
    }

    private isNumericColumn(columnIndex: number): boolean {
        const storage = mapColumnTypeToSqlite(this._columnTypes[columnIndex]);
        return storage === 'INTEGER' || storage === 'REAL';
    }

    private readRecords(sql: string, params: unknown[]): Array<Record<string, unknown>> {
        const statement = prepareValueReadStatement(this._database.prepare(sql));
        return normalizeSqliteRecords(statement.all(...asSqlParams(params)) as Array<Record<string, unknown>>);
    }

    private countAllRows(): number {
        const [row] = this.readRecords('SELECT COUNT(*) AS n FROM result_rows', []);
        return asNumber(row?.n) ?? 0;
    }

    private countGroupKeys(groupColumns: readonly number[]): number {
        const cols = groupColumns.map(quotedColumn).join(', ');
        const [row] = this.readRecords(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM result_rows GROUP BY ${cols})`, []);
        return asNumber(row?.n) ?? 0;
    }

    /**
     * Second moments are taken around a shift (the population mean), not around zero, so the
     * variance stays accurate for large magnitudes such as ids or epoch timestamps.
     */
    private queryPopulationStats(
        statColumns: readonly number[],
        topColumns: ReadonlySet<number>,
        topLimit: number,
    ): DiskColumnGroupStats[] {
        if (statColumns.length === 0) {
            return [];
        }
        const parts: string[] = [];
        statColumns.forEach((columnIndex, j) => {
            const expr = nonNullValue(columnIndex);
            parts.push(
                `COUNT(${expr}) AS nn_${j}`,
                `COUNT(DISTINCT ${expr}) AS dn_${j}`,
                `MIN(${expr}) AS mn_${j}`,
                `MAX(${expr}) AS mx_${j}`,
            );
            if (this.isNumericColumn(columnIndex)) {
                parts.push(`AVG(${expr}) AS av_${j}`);
            }
        });
        const [base = {}] = this.readRecords(`SELECT ${parts.join(', ')} FROM result_rows`, []);

        const shifted = statColumns
            .map((columnIndex, j) => ({ columnIndex, shift: asNumber(base[`av_${j}`]) }))
            .filter((item): item is { columnIndex: number; shift: number } => this.isNumericColumn(item.columnIndex) && item.shift !== null);
        const moments = this.queryShiftedMoments(shifted);

        return statColumns.map((columnIndex, j) => {
            const stats: DiskColumnGroupStats = {
                columnIndex,
                nonNullCount: asNumber(base[`nn_${j}`]) ?? 0,
                distinctCount: asNumber(base[`dn_${j}`]) ?? 0,
                min: normalizeSqliteResultValue(base[`mn_${j}`]) ?? null,
                max: normalizeSqliteResultValue(base[`mx_${j}`]) ?? null,
            };
            if (this.isNumericColumn(columnIndex)) {
                const mean = asNumber(base[`av_${j}`]);
                const moment = moments.get(columnIndex);
                stats.numeric = {
                    mean,
                    stddev: mean !== null && moment ? Math.sqrt(Math.max(0, moment.sq - moment.dd * moment.dd)) : null,
                };
            }
            if (topColumns.has(columnIndex)) {
                stats.topValues = this.queryTopValues(columnIndex, topLimit);
            }
            return stats;
        });
    }

    private queryShiftedMoments(
        columns: ReadonlyArray<{ columnIndex: number; shift: number }>,
    ): Map<number, { dd: number; sq: number }> {
        const moments = new Map<number, { dd: number; sq: number }>();
        if (columns.length === 0) {
            return moments;
        }
        const parts: string[] = [];
        const params: unknown[] = [];
        columns.forEach(({ columnIndex, shift }, k) => {
            const expr = nonNullValue(columnIndex);
            parts.push(`AVG(${expr} - ?) AS dd_${k}`, `AVG((${expr} - ?) * (${expr} - ?)) AS sq_${k}`);
            params.push(shift, shift, shift);
        });
        const [row = {}] = this.readRecords(`SELECT ${parts.join(', ')} FROM result_rows`, params);
        columns.forEach(({ columnIndex }, k) => {
            const dd = asNumber(row[`dd_${k}`]);
            const sq = asNumber(row[`sq_${k}`]);
            if (dd !== null && sq !== null) {
                moments.set(columnIndex, { dd, sq });
            }
        });
        return moments;
    }

    /**
     * Population quartiles from one window pass: ROW_NUMBER orders the numeric values and the outer filter
     * keeps only the ranks the interpolation reads. Non-numeric storage values are skipped, as in the webview.
     */
    private queryQuartiles(columnIndex: number): DiskQuartiles | undefined {
        const col = quotedColumn(columnIndex);
        const rows = this.readRecords(
            `SELECT v, rn, n FROM (
                SELECT ${col} AS v, ROW_NUMBER() OVER (ORDER BY ${col}) - 1 AS rn, COUNT(*) OVER () AS n
                FROM result_rows WHERE typeof(${col}) IN ('integer', 'real')
             ) WHERE rn IN ${QUARTILE_RANK_SQL}`,
            [],
        );
        return quartilesFromRankRows(rows.map(row => ({ v: row.v, rn: row.rn, n: row.n })));
    }

    /** Per-group quartiles: the same window pass partitioned by the grouping columns. */
    private attachGroupQuartiles(
        groups: DiskGroupStatsRow[],
        groupColumns: readonly number[],
        quantileColumns: readonly number[],
    ): void {
        const groupCols = groupColumns.map(quotedColumn).join(', ');
        const byKey = new Map<string, DiskGroupStatsRow>();
        for (const group of groups) {
            byKey.set(groupValuesKey(group.values), group);
        }
        for (const columnIndex of quantileColumns) {
            const col = quotedColumn(columnIndex);
            const rows = this.readRecords(
                `SELECT ${groupCols}, v, rn, n FROM (
                    SELECT ${groupCols}, ${col} AS v,
                        ROW_NUMBER() OVER (PARTITION BY ${groupCols} ORDER BY ${col}) - 1 AS rn,
                        COUNT(*) OVER (PARTITION BY ${groupCols}) AS n
                    FROM result_rows WHERE typeof(${col}) IN ('integer', 'real')
                 ) WHERE rn IN ${QUARTILE_RANK_SQL}`,
                [],
            );
            const rowsByKey = new Map<string, QuartileRankRow[]>();
            for (const row of rows) {
                const values = groupColumns.map(index => normalizeSqliteResultValue(row[sqliteColumnName(index)]) ?? null);
                const key = groupValuesKey(values);
                const bucket = rowsByKey.get(key) ?? [];
                bucket.push({ v: row.v, rn: row.rn, n: row.n });
                rowsByKey.set(key, bucket);
            }
            for (const [key, bucket] of rowsByKey) {
                const stats = byKey.get(key)?.columns.find(column => column.columnIndex === columnIndex);
                const quartiles = quartilesFromRankRows(bucket);
                if (stats?.numeric && quartiles) {
                    stats.numeric.quartiles = quartiles;
                }
            }
        }
    }

    private queryTopValues(columnIndex: number, limit: number): DiskTopValue[] {
        const col = quotedColumn(columnIndex);
        const rows = this.readRecords(
            `SELECT ${col} AS v, COUNT(*) AS cnt FROM result_rows WHERE ${nonNullValue(columnIndex)} IS NOT NULL GROUP BY ${col} ORDER BY cnt DESC, v LIMIT ?`,
            [limit],
        );
        return rows.map(row => ({ value: normalizeSqliteResultValue(row.v), count: asNumber(row.cnt) ?? 0 }));
    }

    private queryGroupStatRows(
        groupColumns: readonly number[],
        statColumns: readonly number[],
        population: readonly DiskColumnGroupStats[],
        limit: number,
    ): { groups: DiskGroupStatsRow[]; listedRows: number } {
        const groupCols = groupColumns.map(quotedColumn);
        const parts: string[] = groupCols.map((col, j) => `${col} AS g_${j}`);
        parts.push('COUNT(*) AS n');
        const params: unknown[] = [];
        statColumns.forEach((columnIndex, j) => {
            const expr = nonNullValue(columnIndex);
            parts.push(
                `COUNT(${expr}) AS nn_${j}`,
                `COUNT(DISTINCT ${expr}) AS dn_${j}`,
                `MIN(${expr}) AS mn_${j}`,
                `MAX(${expr}) AS mx_${j}`,
            );
            const shift = this.populationMean(population, columnIndex);
            if (this.isNumericColumn(columnIndex) && shift !== null) {
                parts.push(`AVG(${expr} - ?) AS dd_${j}`, `AVG((${expr} - ?) * (${expr} - ?)) AS sq_${j}`);
                params.push(shift, shift, shift);
            }
        });
        params.push(limit);

        const rows = this.readRecords(
            `SELECT ${parts.join(', ')} FROM result_rows
             GROUP BY ${groupCols.join(', ')}
             ORDER BY COUNT(*) DESC, ${groupCols.map(col => `CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END ASC, CAST(${col} AS TEXT) ASC`).join(', ')}
             LIMIT ?`,
            params,
        );

        let listedRows = 0;
        const groups = rows.map((row): DiskGroupStatsRow => {
            const count = asNumber(row.n) ?? 0;
            listedRows += count;
            return {
                values: groupColumns.map((_, j) => normalizeSqliteResultValue(row[`g_${j}`]) ?? null),
                count,
                columns: statColumns.map((columnIndex, j) => this.groupColumnStats(row, j, columnIndex, population)),
            };
        });
        return { groups, listedRows };
    }

    private populationMean(population: readonly DiskColumnGroupStats[], columnIndex: number): number | null {
        return population.find(column => column.columnIndex === columnIndex)?.numeric?.mean ?? null;
    }

    private groupColumnStats(
        row: Record<string, unknown>,
        j: number,
        columnIndex: number,
        population: readonly DiskColumnGroupStats[],
    ): DiskColumnGroupStats {
        const stats: DiskColumnGroupStats = {
            columnIndex,
            nonNullCount: asNumber(row[`nn_${j}`]) ?? 0,
            distinctCount: asNumber(row[`dn_${j}`]) ?? 0,
            min: normalizeSqliteResultValue(row[`mn_${j}`]) ?? null,
            max: normalizeSqliteResultValue(row[`mx_${j}`]) ?? null,
        };
        if (this.isNumericColumn(columnIndex)) {
            const shift = this.populationMean(population, columnIndex);
            const dd = asNumber(row[`dd_${j}`]);
            const sq = asNumber(row[`sq_${j}`]);
            const hasMoments = shift !== null && dd !== null && sq !== null;
            stats.numeric = hasMoments
                ? { mean: shift + dd, stddev: Math.sqrt(Math.max(0, sq - dd * dd)) }
                : { mean: null, stddev: null };
        }
        return stats;
    }

    /** Same gates as the in-memory engine; empty strings count as null-like, as in memory. */
    private isRareCandidate(columnIndex: number, population: readonly DiskColumnGroupStats[], totalGroups: number): boolean {
        const stats = population.find(column => column.columnIndex === columnIndex);
        if (!stats || totalGroups < RARE_MIN_GROUPS) {
            return false;
        }
        return stats.distinctCount >= RARE_MIN_DISTINCT
            && stats.distinctCount <= RARE_MAX_DISTINCT
            && stats.nonNullCount >= RARE_MIN_NON_NULL
            && stats.distinctCount / stats.nonNullCount <= RARE_MAX_DISTINCT_RATIO;
    }

    /**
     * A value is rare for a group when exactly one (group, value) pair holds it and it occurs at most
     * a few times. Rows of unlisted groups are dropped, so a value owned by an unlisted group is not reported.
     */
    private attachGroupRareValues(
        groups: DiskGroupStatsRow[],
        groupColumns: readonly number[],
        rareColumns: readonly number[],
    ): void {
        const groupCols = groupColumns.map(quotedColumn);
        const groupList = groupCols.join(', ');
        const byKey = new Map<string, DiskGroupStatsRow>();
        for (const group of groups) {
            byKey.set(groupValuesKey(group.values), group);
        }
        for (const columnIndex of rareColumns) {
            const col = quotedColumn(columnIndex);
            const rows = this.readRecords(
                `SELECT ${groupCols.map((c, j) => `MIN(${c}) AS g_${j}`).join(', ')}, ${col} AS v, SUM(cnt) AS total
                 FROM (
                    SELECT ${groupList}, ${col}, COUNT(*) AS cnt
                    FROM result_rows
                    WHERE ${col} IS NOT NULL AND CAST(${col} AS TEXT) <> ''
                    GROUP BY ${groupList}, ${col}
                 )
                 GROUP BY ${col}
                 HAVING COUNT(*) = 1 AND SUM(cnt) <= ?`,
                [RARE_MAX_OCCURRENCES],
            );
            for (const row of rows) {
                const values = groupColumns.map((_, j) => normalizeSqliteResultValue(row[`g_${j}`]) ?? null);
                const group = byKey.get(groupValuesKey(values));
                const stats = group?.columns.find(column => column.columnIndex === columnIndex);
                if (!stats) continue;
                const rare = stats.rare ?? { total: 0, examples: [] };
                rare.total += 1;
                rare.examples.push(String(normalizeSqliteResultValue(row.v) ?? ''));
                stats.rare = rare;
            }
        }
        for (const group of groups) {
            for (const stats of group.columns) {
                if (stats.rare) {
                    stats.rare.examples = stats.rare.examples.sort().slice(0, RARE_MAX_EXAMPLES);
                }
            }
        }
    }

    /**
     * Ranked value counts per group for the given columns. 'topValues' keeps the detail-pane list (every
     * column is reset, as before); 'categories' is filled only for the requested columns, so an absent
     * field still means "no complete distribution".
     */
    private attachGroupValueCounts(
        groups: DiskGroupStatsRow[],
        groupColumns: readonly number[],
        columns: readonly number[],
        limit: number,
        field: 'topValues' | 'categories',
    ): void {
        const groupCols = groupColumns.map(quotedColumn).join(', ');
        const byKey = new Map<string, DiskGroupStatsRow>();
        for (const group of groups) {
            byKey.set(groupValuesKey(group.values), group);
            for (const column of group.columns) {
                // Only the requested columns are reset; values filled earlier for other columns must survive.
                if (columns.includes(column.columnIndex)) {
                    column[field] = [];
                }
            }
        }

        for (const columnIndex of columns) {
            const col = quotedColumn(columnIndex);
            const rows = this.readRecords(
                `SELECT ${groupCols}, v, cnt FROM (
                    SELECT ${groupCols}, v, cnt,
                        ROW_NUMBER() OVER (PARTITION BY ${groupCols} ORDER BY cnt DESC, v) AS rn
                    FROM (
                        SELECT ${groupCols}, ${col} AS v, COUNT(*) AS cnt
                        FROM result_rows
                        WHERE ${nonNullValue(columnIndex)} IS NOT NULL
                        GROUP BY ${groupCols}, ${col}
                    )
                ) WHERE rn <= ?
                ORDER BY ${groupCols}, rn`,
                [limit],
            );
            for (const row of rows) {
                const values = groupColumns.map(index => normalizeSqliteResultValue(row[sqliteColumnName(index)]) ?? null);
                const group = byKey.get(groupValuesKey(values));
                const stats = group?.columns.find(column => column.columnIndex === columnIndex);
                stats?.[field]?.push({ value: normalizeSqliteResultValue(row.v), count: asNumber(row.cnt) ?? 0 });
            }
        }
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
