const DB2_RESERVED_KEYWORDS = new Set([
    'ADD', 'ALTER', 'AND', 'AS', 'BY', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CURRENT', 'DATE',
    'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'EXISTS', 'FOREIGN', 'FROM', 'FULL', 'GROUP',
    'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'PROCEDURE', 'REFERENCES', 'RIGHT', 'SCHEMA',
    'SELECT', 'SET', 'TABLE', 'TIME', 'TIMESTAMP', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'VALUES', 'VIEW',
    'WHERE'
]);

export interface Db2IndexKeyColumn {
    name: string;
    order: 'ASC' | 'DESC';
}

export interface Db2CreateIndexDdlOptions {
    schema: string;
    tableName: string;
    indexName: string;
    keyColumns: readonly Db2IndexKeyColumn[];
    includeColumns?: readonly string[];
    unique?: boolean;
    clustered?: boolean;
    reverseScans?: 'allow' | 'disallow';
    compress?: 'yes' | 'no';
    pctFree?: number;
    level2PctFree?: number;
    minPctUsed?: number;
    pageSplit?: 'symmetric' | 'high';
    collectStatistics?: 'sampled' | 'detailed';
    tablespace?: string;
    additionalClause?: string;
}

export interface Db2PartitionRangeOptions {
    partitionName: string;
    startingFrom: string;
    startingInclusive: boolean;
    endingAt: string;
    endingInclusive: boolean;
    tablespace?: string;
    indexTablespace?: string;
    longTablespace?: string;
}

export interface Db2AddPartitionDdlOptions extends Db2PartitionRangeOptions {
    schema: string;
    tableName: string;
}

export interface Db2AttachPartitionDdlOptions extends Omit<Db2PartitionRangeOptions, 'tablespace' | 'indexTablespace' | 'longTablespace'> {
    schema: string;
    tableName: string;
    sourceSchema: string;
    sourceTable: string;
}

export interface Db2DetachPartitionDdlOptions {
    schema: string;
    tableName: string;
    partitionName: string;
    detachedSchema: string;
    detachedTable: string;
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

export function formatDb2Identifier(identifier: string): string {
    const trimmed = identifier.trim();
    if (/^[A-Z_][A-Z0-9_$#@]*$/.test(trimmed) && !DB2_RESERVED_KEYWORDS.has(trimmed)) {
        return trimmed;
    }
    return quoteIdentifier(trimmed);
}

export function formatDb2QualifiedName(schema: string, objectName: string): string {
    return `${formatDb2Identifier(schema)}.${formatDb2Identifier(objectName)}`;
}

function formatPercent(value: number | undefined, clause: string): string | undefined {
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 99) {
        return undefined;
    }
    return `${clause} ${value}`;
}

function requireValue(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error(`${label} is required.`);
    }
    return trimmed;
}

export function buildDb2CreateIndexSql(options: Db2CreateIndexDdlOptions): string {
    const indexName = requireValue(options.indexName, 'Index name');
    const keyColumns = options.keyColumns.filter(column => column.name.trim().length > 0);
    if (keyColumns.length === 0) {
        throw new Error('Select at least one key column.');
    }

    const keyColumnSql = keyColumns
        .map(column => `${formatDb2Identifier(column.name)}${column.order === 'DESC' ? ' DESC' : ''}`)
        .join(', ');
    const includeColumns = (options.includeColumns ?? [])
        .map(column => column.trim())
        .filter(column => column.length > 0);
    const clauses = [
        `CREATE ${options.unique ? 'UNIQUE ' : ''}INDEX ${formatDb2QualifiedName(options.schema, indexName)} ON ${formatDb2QualifiedName(options.schema, options.tableName)} (${keyColumnSql})`,
        includeColumns.length > 0 ? `INCLUDE (${includeColumns.map(formatDb2Identifier).join(', ')})` : undefined,
        formatPercent(options.pctFree, 'PCTFREE'),
        formatPercent(options.level2PctFree, 'LEVEL2 PCTFREE'),
        formatPercent(options.minPctUsed, 'MINPCTUSED'),
        options.reverseScans === 'allow' ? 'ALLOW REVERSE SCANS' : options.reverseScans === 'disallow' ? 'DISALLOW REVERSE SCANS' : undefined,
        options.pageSplit === 'symmetric' ? 'PAGE SPLIT SYMMETRIC' : options.pageSplit === 'high' ? 'PAGE SPLIT HIGH' : undefined,
        options.collectStatistics === 'sampled' ? 'COLLECT SAMPLED DETAILED STATISTICS' : options.collectStatistics === 'detailed' ? 'COLLECT DETAILED STATISTICS' : undefined,
        options.compress === 'yes' ? 'COMPRESS YES' : options.compress === 'no' ? 'COMPRESS NO' : undefined,
        options.tablespace?.trim() ? `IN ${formatDb2Identifier(options.tablespace)}` : undefined,
        options.clustered ? 'CLUSTER' : undefined,
        options.additionalClause?.trim() || undefined
    ].filter((clause): clause is string => Boolean(clause));

    return `${clauses.join(' ')};`;
}

export function buildDb2PartitionRangeSql(options: Db2PartitionRangeOptions, includeStorage = true): string {
    const partitionName = requireValue(options.partitionName, 'Partition name');
    const startingFrom = requireValue(options.startingFrom, 'Starting boundary');
    const endingAt = requireValue(options.endingAt, 'Ending boundary');
    const clauses = [
        `PARTITION ${formatDb2Identifier(partitionName)}`,
        `STARTING FROM ${startingFrom} ${options.startingInclusive ? 'INCLUSIVE' : 'EXCLUSIVE'}`,
        `ENDING AT ${endingAt} ${options.endingInclusive ? 'INCLUSIVE' : 'EXCLUSIVE'}`,
        includeStorage && options.tablespace?.trim() ? `IN ${formatDb2Identifier(options.tablespace)}` : undefined,
        includeStorage && options.indexTablespace?.trim() ? `INDEX IN ${formatDb2Identifier(options.indexTablespace)}` : undefined,
        includeStorage && options.longTablespace?.trim() ? `LONG IN ${formatDb2Identifier(options.longTablespace)}` : undefined
    ].filter((clause): clause is string => Boolean(clause));

    return clauses.join(' ');
}

export function buildDb2AddPartitionSql(options: Db2AddPartitionDdlOptions): string {
    return `ALTER TABLE ${formatDb2QualifiedName(options.schema, options.tableName)} ADD ${buildDb2PartitionRangeSql(options)};`;
}

export function buildDb2AttachPartitionSql(options: Db2AttachPartitionDdlOptions): string {
    return `ALTER TABLE ${formatDb2QualifiedName(options.schema, options.tableName)} ATTACH ${buildDb2PartitionRangeSql(options, false)} FROM TABLE ${formatDb2QualifiedName(options.sourceSchema, options.sourceTable)};`;
}

export function buildDb2SetIntegritySql(schema: string, tableName: string): string {
    return `SET INTEGRITY FOR ${formatDb2QualifiedName(schema, tableName)} IMMEDIATE CHECKED;`;
}

export function buildDb2DetachPartitionSql(options: Db2DetachPartitionDdlOptions): string {
    return `ALTER TABLE ${formatDb2QualifiedName(options.schema, options.tableName)} DETACH PARTITION ${formatDb2Identifier(requireValue(options.partitionName, 'Partition name'))} INTO ${formatDb2QualifiedName(options.detachedSchema, options.detachedTable)};`;
}

export function buildDb2DropPartitionSql(options: Db2DetachPartitionDdlOptions): string[] {
    const detachedTable = formatDb2QualifiedName(options.detachedSchema, options.detachedTable);
    return [
        buildDb2DetachPartitionSql(options),
        `DROP TABLE ${detachedTable};`
    ];
}
