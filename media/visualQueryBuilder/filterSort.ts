/**
 * Pure helpers for the Access-style filter/sort design grid.
 * Kept free of React so the SQL-generation logic stays unit-testable.
 */

export type QueryGridSort = 'ASC' | 'DESC' | 'NONE';

/**
 * Access "Total" row semantics: GROUP BY/WHERE are non-aggregate roles,
 * the remaining values are Netezza aggregate functions; EXPRESSION treats
 * the field cell as a raw SQL expression.
 */
export type QueryGridAggregate =
    | 'NONE'
    | 'GROUP BY'
    | 'WHERE'
    | 'SUM'
    | 'AVG'
    | 'MIN'
    | 'MAX'
    | 'COUNT'
    | 'COUNT DISTINCT'
    | 'STDDEV'
    | 'VARIANCE'
    | 'EXPRESSION';

export interface QueryGridColumn {
    id: string;
    tableInstanceId: string;
    columnName: string;
    /** Whether the field is included in the SELECT list (Access "Show" row). */
    show: boolean;
    /** Access "Total" row; NONE means a plain (implicitly grouped) field. */
    aggregate: QueryGridAggregate;
    sort: QueryGridSort;
    /** Criteria row plus additional OR rows (Access design grid). */
    criteriaRows: string[];
}

/** Criteria row plus the number of extra OR rows rendered in the grid. */
export const GRID_CRITERIA_ROWS = 3;

/** Aggregate functions offered in the Total row. */
export const GRID_AGGREGATE_FUNCTIONS: readonly QueryGridAggregate[] = [
    'SUM',
    'AVG',
    'MIN',
    'MAX',
    'COUNT',
    'COUNT DISTINCT',
    'STDDEV',
    'VARIANCE',
];

/** Structural subset of PlacedTable needed to generate grid predicates. */
export interface GridSourceTable {
    instanceId: string;
    alias: string;
}

export interface GridSqlParts {
    select: string;
    where: string;
    groupBy: string;
    having: string;
    orderBy: string;
}

export function quoteIdentifier(value: string): string {
    if (/^[A-Z_][A-Z0-9_]*$/.test(value) && value === value.toUpperCase()) {
        return value;
    }
    return `"${value.replace(/"/g, '""')}"`;
}

const CRITERIA_OPERATOR_PREFIX = /^\s*(?:<>|<=|>=|!=|[<>=]|(?:LIKE|NOT|IN|BETWEEN|IS)\b)/i;

/**
 * Normalizes a design-grid criteria cell. Access implicitly prepends `=` to
 * expressions that do not start with a comparison operator.
 */
export function normalizeGridCriteria(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (CRITERIA_OPERATOR_PREFIX.test(trimmed)) return trimmed;
    return `= ${trimmed}`;
}

export function isAggregateFunction(aggregate: QueryGridAggregate): boolean {
    return GRID_AGGREGATE_FUNCTIONS.includes(aggregate);
}

function findSource(
    sources: readonly GridSourceTable[],
    column: QueryGridColumn,
): GridSourceTable | undefined {
    return sources.find(candidate => candidate.instanceId === column.tableInstanceId);
}

function qualifiedField(column: QueryGridColumn, source: GridSourceTable): string {
    return `${quoteIdentifier(source.alias)}.${quoteIdentifier(column.columnName)}`;
}

/**
 * The SQL expression a column contributes: the aggregate call, the raw
 * expression text (Total = Expression), or the plain qualified field.
 * Returns '' when the column cannot contribute an expression.
 */
function columnExpression(column: QueryGridColumn, source: GridSourceTable): string {
    if (column.aggregate === 'EXPRESSION') {
        return column.columnName.trim();
    }
    if (!column.columnName.trim()) return '';
    if (column.aggregate === 'COUNT DISTINCT') {
        return `COUNT(DISTINCT ${qualifiedField(column, source)})`;
    }
    if (isAggregateFunction(column.aggregate)) {
        return `${column.aggregate}(${qualifiedField(column, source)})`;
    }
    return qualifiedField(column, source);
}

/**
 * Builds the SELECT list contributed by the design grid, in grid order.
 * Columns with Show unchecked, or Total = Where, are omitted. Expression
 * fields embed their raw text even without a selected source; regular fields
 * require a source to be qualified.
 */
export function buildGridSelectClause(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
): string {
    const parts: string[] = [];
    for (const column of columns) {
        if (!column.show || column.aggregate === 'WHERE') continue;
        const source = findSource(sources, column);
        const expression = source
            ? columnExpression(column, source)
            : column.aggregate === 'EXPRESSION' ? column.columnName.trim() : '';
        if (expression) parts.push(expression);
    }
    return parts.join(',\n    ');
}

/**
 * Groups AND-ed predicates of one criteria row and ORs the rows together,
 * mirroring the MS Access design grid semantics. The expression callback
 * receives the column's source when the column references one (undefined for
 * source-less Expression fields).
 */
function buildRowGroupedPredicates(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
    expressionFor: (column: QueryGridColumn, source: GridSourceTable | undefined) => string,
): string {
    const groups: string[][] = [];
    for (const column of columns) {
        const source = findSource(sources, column);
        const expression = expressionFor(column, source);
        if (!expression) continue;
        column.criteriaRows.forEach((raw, rowIndex) => {
            const criteria = normalizeGridCriteria(raw);
            if (!criteria) return;
            const group = groups[rowIndex] ?? (groups[rowIndex] = []);
            group.push(`${expression} ${criteria}`);
        });
    }
    const populated = groups.filter(group => group.length > 0);
    if (populated.length === 0) return '';
    if (populated.length === 1) return populated[0].join(' AND ');
    return `(${populated.map(group => group.join(' AND ')).join(') OR (')})`;
}

/**
 * Builds the WHERE expression contributed by the design grid. Only
 * non-aggregated columns (plain, Group By, Where) contribute; criteria on
 * aggregated columns become HAVING predicates instead.
 */
export function buildGridWhereClause(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
): string {
    return buildRowGroupedPredicates(columns, sources, (column, source) => {
        if (column.aggregate === 'EXPRESSION' || isAggregateFunction(column.aggregate)) {
            return '';
        }
        return source && column.columnName.trim() ? qualifiedField(column, source) : '';
    });
}

/**
 * Builds the HAVING expression contributed by the design grid: criteria on
 * columns with an aggregate function or raw Expression (Access semantics).
 * Expression fields embed their raw text even without a selected source.
 */
export function buildGridHavingClause(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
): string {
    return buildRowGroupedPredicates(columns, sources, (column, source) => {
        if (column.aggregate === 'EXPRESSION') {
            return column.columnName.trim();
        }
        if (isAggregateFunction(column.aggregate)) {
            return source ? columnExpression(column, source) : '';
        }
        return '';
    });
}

/**
 * Builds the GROUP BY expression contributed by the design grid.
 * Explicit Group By columns always group; plain shown fields implicitly
 * group once the grid contains any aggregate (Access semantics).
 */
export function buildGridGroupByClause(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
): string {
    const hasAggregate = columns.some(column =>
        column.aggregate === 'EXPRESSION' || isAggregateFunction(column.aggregate),
    );
    const parts: string[] = [];
    for (const column of columns) {
        if (!column.columnName.trim()) continue;
        if (column.aggregate === 'WHERE') continue;
        if (column.aggregate === 'EXPRESSION' || isAggregateFunction(column.aggregate)) continue;
        if (column.aggregate === 'GROUP BY' || (hasAggregate && column.show)) {
            const source = findSource(sources, column);
            if (source) parts.push(qualifiedField(column, source));
        }
    }
    return parts.join(', ');
}

/**
 * Builds the ORDER BY expression contributed by the design grid, in column
 * order. Aggregated columns sort by their aggregate call; Expression fields
 * sort by their raw text even without a selected source.
 */
export function buildGridOrderByClause(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
): string {
    const parts: string[] = [];
    for (const column of columns) {
        if (column.sort === 'NONE' || column.aggregate === 'WHERE') continue;
        const source = findSource(sources, column);
        const expression = source
            ? columnExpression(column, source)
            : column.aggregate === 'EXPRESSION' ? column.columnName.trim() : '';
        if (!expression) continue;
        parts.push(`${expression} ${column.sort}`);
    }
    return parts.join(', ');
}

/** Reorders a grid column by one position (up/down); returns a new array. */
export function moveGridColumn(
    columns: readonly QueryGridColumn[],
    columnId: string,
    delta: -1 | 1,
): QueryGridColumn[] {
    const index = columns.findIndex(column => column.id === columnId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= columns.length) return [...columns];
    const next = [...columns];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
}

/**
 * Fills in defaults for grid columns loaded from persisted state, so older
 * snapshots without Show/Total settings keep working.
 */
export function normalizeGridColumn(column: Partial<QueryGridColumn> & { id: string }): QueryGridColumn {
    const criteria = Array.isArray(column.criteriaRows) ? column.criteriaRows : [];
    return {
        ...column,
        tableInstanceId: column.tableInstanceId || '',
        columnName: column.columnName || '',
        show: column.show !== false,
        aggregate: column.aggregate || 'NONE',
        sort: column.sort || 'NONE',
        criteriaRows: Array.from({ length: GRID_CRITERIA_ROWS }, (_, index) => criteria[index] ?? ''),
    };
}

/** Builds every SQL fragment the design grid contributes, in one pass. */
export function buildGridSqlParts(
    columns: readonly QueryGridColumn[],
    sources: readonly GridSourceTable[],
): GridSqlParts {
    return {
        select: buildGridSelectClause(columns, sources),
        where: buildGridWhereClause(columns, sources),
        groupBy: buildGridGroupByClause(columns, sources),
        having: buildGridHavingClause(columns, sources),
        orderBy: buildGridOrderByClause(columns, sources),
    };
}