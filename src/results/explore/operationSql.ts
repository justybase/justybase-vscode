import type { ExploreFilterModel, ExploreOperation, ExploreRankingConfig } from '@justybase/contracts';
import type { ColumnDefinition } from '../../types';
import { buildExploreWhereSql, escapeSqlLiteral, quoteIdentifier } from './exploreFilters';

/** Keep user limits and ordering intact. SQL Server cannot nest a CTE in a derived table. */
export function exploreSourceSql(sql: string, databaseKind?: string): string {
    const source = sql.trim().replace(/;\s*$/, '').trim();
    if (!source) throw new Error('This result has no source SQL.');
    if (databaseKind === 'access') throw new Error('Database exploration is not supported for Access results. Use the sample instead.');
    if (databaseKind === 'mssql' && /^WITH\b/i.test(source)) {
        throw new Error('Database exploration of a SQL Server CTE is unavailable. Open the SQL in an editor.');
    }
    return source;
}

export function exploreLimit(sql: string, limit: number, kind?: string): string {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5001) throw new Error('Invalid Explore row limit.');
    // T-SQL requires TOP after DISTINCT: SELECT DISTINCT TOP (n) ...
    if (kind === 'mssql') return sql.replace(/^SELECT(\s+DISTINCT)?\s/i, (_match, distinct?: string) => `SELECT${distinct ? ' DISTINCT' : ''} TOP (${limit}) `);
    return `${sql}\n${kind === 'oracle' || kind === 'db2' ? `FETCH FIRST ${limit} ROWS ONLY` : `LIMIT ${limit}`}`;
}

function stableColumn(columns: readonly ColumnDefinition[], index: number): ColumnDefinition {
    const column = columns[index];
    if (!Number.isInteger(index) || !column?.name?.trim() || columns.filter(item => item.name === column.name).length !== 1) {
        throw new Error('Explore requires unique output column names. Add aliases to the source SQL.');
    }
    return column;
}

export function validateExploreFilters(filters: ExploreFilterModel, columns: readonly ColumnDefinition[]): void {
    if (!filters || !Array.isArray(filters.dimensions) || !Array.isArray(filters.dates) || !Array.isArray(filters.measures)) {
        throw new Error('Invalid Explore filters.');
    }
    for (const filter of [...filters.dimensions, ...filters.dates, ...filters.measures]) stableColumn(columns, filter.columnIndex);
    for (const filter of filters.dimensions) {
        if (!Array.isArray(filter.values) || filter.values.length > 1000 || filter.values.some(value => !['string', 'number', 'boolean'].includes(typeof value))) {
            throw new Error('Invalid category filter values.');
        }
        if (filter.mode && !['include', 'exclude'].includes(filter.mode)) throw new Error('Invalid category filter mode.');
    }
}

export function buildRankingSql(source: string, columns: readonly ColumnDefinition[], config: ExploreRankingConfig, kind?: string): string {
    if (!Number.isInteger(config.count) || config.count < 1 || config.count > 100) throw new Error('Ranking size must be between 1 and 100.');
    if (!['top', 'bottom'].includes(config.direction)) throw new Error('Invalid ranking direction.');
    if (!['count', 'sum', 'avg', 'min', 'max', 'countDistinct'].includes(config.aggregate)) throw new Error('Invalid ranking aggregate.');
    const category = stableColumn(columns, config.categoryColumnIndex);
    const measure = config.aggregate === 'count' ? undefined : stableColumn(columns, config.measureColumnIndex ?? -1);
    const q = (name: string) => quoteIdentifier(name, kind);
    const categorySql = `t.${q(category.name)}`;
    const valueSql = measure ? `t.${q(measure.name)}` : '*';
    const aggregate = config.aggregate === 'countDistinct' ? `COUNT(DISTINCT ${valueSql})` : `${config.aggregate.toUpperCase()}(${valueSql})`;
    const filters = config.filters ?? { dimensions: [], dates: [], measures: [] };
    validateExploreFilters(filters, columns);
    const where = buildExploreWhereSql(filters, columns, kind);
    const additive = config.aggregate === 'count' || config.aggregate === 'sum';
    const share = config.showShare && additive ? `CASE WHEN negative_count = 0 AND total_value > 0 THEN 100.0 * v / total_value ELSE NULL END` : 'NULL';
    const other = config.includeOther && additive ? `\nUNION ALL\nSELECT NULL AS ${q('CATEGORY')}, SUM(v) AS ${q('VALUE')}, ${config.showShare ? 'CASE WHEN MAX(negative_count) = 0 AND MAX(total_value) > 0 THEN 100.0 * SUM(v) / MAX(total_value) ELSE NULL END' : 'NULL'} AS ${q('SHARE')}, 1 AS ${q('IS_OTHER')}, ${config.count + 1} AS ${q('SORT_ORDER')} FROM jb_ranked WHERE rn > ${config.count} HAVING COUNT(*) > 0` : '';
    return `WITH jb_groups AS (\nSELECT ${categorySql} AS k, ${aggregate} AS v\nFROM (\n${exploreSourceSql(source, kind)}\n) t\n${where ? `WHERE ${where}\n` : ''}GROUP BY ${categorySql}\n), jb_ranked AS (\nSELECT k, v, ROW_NUMBER() OVER (ORDER BY CASE WHEN v IS NULL THEN 1 ELSE 0 END, v ${config.direction === 'top' ? 'DESC' : 'ASC'}, CASE WHEN k IS NULL THEN 0 ELSE 1 END, k) AS rn, SUM(v) OVER () AS total_value, SUM(CASE WHEN v < 0 THEN 1 ELSE 0 END) OVER () AS negative_count FROM jb_groups\n)\nSELECT k AS ${q('CATEGORY')}, v AS ${q('VALUE')}, ${share} AS ${q('SHARE')}, 0 AS ${q('IS_OTHER')}, rn AS ${q('SORT_ORDER')} FROM jb_ranked WHERE rn <= ${config.count}${other}\nORDER BY ${q('SORT_ORDER')}`;
}

/** Build bounded queries for explicit database actions; never strip a user limit. */
export function buildExploreOperationSql(source: string, columns: readonly ColumnDefinition[], operation: ExploreOperation, kind?: string): string {
    if (operation.kind === 'ranking') return buildRankingSql(source, columns, operation.config, kind);
    if (operation.kind !== 'rows' && operation.kind !== 'values') throw new Error('Unsupported Explore operation.');
    const filters = operation.filters;
    validateExploreFilters(filters, columns);
    const where = buildExploreWhereSql(filters, columns, kind);
    const from = `FROM (\n${exploreSourceSql(source, kind)}\n) t`;
    if (operation.kind === 'rows') {
        return exploreLimit(`SELECT *\n${from}${where ? `\nWHERE ${where}` : ''}`, 1001, kind);
    }
    if (typeof operation.search !== 'string' || operation.search.length > 1000) throw new Error('Invalid value search.');
    const column = stableColumn(columns, operation.columnIndex);
    const value = `t.${quoteIdentifier(column.name, kind)}`;
    const search = operation.search.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
    const cast = kind === 'oracle' ? `CAST(${value} AS VARCHAR2(4000))` : kind === 'mssql' ? `CAST(${value} AS NVARCHAR(4000))` : kind === 'sqlite' ? `CAST(${value} AS TEXT)` : kind === 'mysql' ? `CAST(${value} AS CHAR)` : `CAST(${value} AS VARCHAR(4000))`;
    const conditions = [where, search ? `${cast} LIKE ${escapeSqlLiteral(`%${search}%`)} ESCAPE '!'` : ''].filter(Boolean);
    return exploreLimit(`SELECT DISTINCT ${value}\n${from}${conditions.length ? `\nWHERE ${conditions.join('\nAND ')}` : ''}\nORDER BY ${value}`, 101, kind);
}
