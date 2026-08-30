import {
    formatIdentifierForSql,
    formatQualifiedObjectName,
} from '../../../src/utils/identifierUtils';

export interface MysqlIndexKeyColumn {
    name: string;
    order: 'ASC' | 'DESC';
}

export interface MysqlCreateIndexDdlOptions {
    schema: string;
    tableName: string;
    indexName: string;
    keyColumns: readonly MysqlIndexKeyColumn[];
    unique?: boolean;
    allowDescending?: boolean;
}

export interface MysqlAddRangeListPartitionDdlOptions {
    schema: string;
    tableName: string;
    partitionName: string;
    valuesClause: string;
    method: 'RANGE' | 'LIST';
}

export interface MysqlAddHashKeyPartitionDdlOptions {
    schema: string;
    tableName: string;
    partitionCount: number;
}

export interface MysqlDropPartitionDdlOptions {
    schema: string;
    tableName: string;
    partitionName: string;
}

export interface MysqlCoalescePartitionDdlOptions {
    schema: string;
    tableName: string;
    partitionCount: number;
}

function requireValue(value: string | undefined, label: string): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
        throw new Error(`${label} is required.`);
    }
    return trimmed;
}

function identifierKey(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
        return trimmed.slice(1, -1).replace(/``/g, '`').toLowerCase();
    }
    return trimmed.toLowerCase();
}

export function areMysqlIdentifiersEqual(left: string, right: string): boolean {
    return identifierKey(left) === identifierKey(right);
}

function requirePositiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}

function validateValuesClause(valuesClause: string, method: 'RANGE' | 'LIST'): string {
    const value = requireValue(valuesClause, 'Partition values clause');
    if (/[;]|--|\/\*|\*\/|#/.test(value)) {
        throw new Error('Partition values clause cannot contain SQL statement separators or comments.');
    }

    const keyword = method === 'RANGE' ? 'VALUES LESS THAN' : 'VALUES IN';
    const pattern = method === 'RANGE'
        ? /^(?:VALUES LESS THAN MAXVALUE|VALUES LESS THAN\s*\([\s\S]+\))$/i
        : /^VALUES IN\s*\([\s\S]+\)$/i;
    if (!pattern.test(value)) {
        throw new Error(`Use ${keyword} (... ) for a ${method} partition.`);
    }
    return value;
}

export function buildMysqlCreateIndexSql(options: MysqlCreateIndexDdlOptions): string {
    const schema = requireValue(options.schema, 'Schema');
    const tableName = requireValue(options.tableName, 'Table name');
    const indexName = requireValue(options.indexName, 'Index name');
    if (!Array.isArray(options.keyColumns) || options.keyColumns.length === 0) {
        throw new Error('Select at least one index column.');
    }

    const seenColumns = new Set<string>();
    const keyColumns = options.keyColumns.map(column => {
        const name = requireValue(column.name, 'Index column');
        const key = identifierKey(name);
        if (seenColumns.has(key)) {
            throw new Error(`Column "${name}" can only be selected once.`);
        }
        seenColumns.add(key);
        const order = column.order === 'DESC' ? 'DESC' : 'ASC';
        if (order === 'DESC' && options.allowDescending !== true) {
            throw new Error('Descending indexes are not supported for this MySQL table.');
        }
        return `${formatIdentifierForSql(name, 'mysql')} ${order}`;
    }).join(', ');

    const qualifiedTable = formatQualifiedObjectName(undefined, schema, tableName, 'mysql');
    return `CREATE ${options.unique === true ? 'UNIQUE ' : ''}INDEX ${formatIdentifierForSql(indexName, 'mysql')} ON ${qualifiedTable} (${keyColumns});`;
}

export function buildMysqlDropIndexSql(schema: string, tableName: string, indexName: string): string {
    return `DROP INDEX ${formatIdentifierForSql(requireValue(indexName, 'Index name'), 'mysql')} ON ${formatQualifiedObjectName(undefined, requireValue(schema, 'Schema'), requireValue(tableName, 'Table name'), 'mysql')};`;
}

export function buildMysqlAddRangeListPartitionSql(options: MysqlAddRangeListPartitionDdlOptions): string {
    const method = options.method === 'LIST' ? 'LIST' : 'RANGE';
    const valuesClause = validateValuesClause(options.valuesClause, method);
    return `ALTER TABLE ${formatQualifiedObjectName(undefined, requireValue(options.schema, 'Schema'), requireValue(options.tableName, 'Table name'), 'mysql')} ADD PARTITION (PARTITION ${formatIdentifierForSql(requireValue(options.partitionName, 'Partition name'), 'mysql')} ${valuesClause});`;
}

export function buildMysqlAddHashKeyPartitionSql(options: MysqlAddHashKeyPartitionDdlOptions): string {
    const partitionCount = requirePositiveInteger(options.partitionCount, 'Partition count');
    return `ALTER TABLE ${formatQualifiedObjectName(undefined, requireValue(options.schema, 'Schema'), requireValue(options.tableName, 'Table name'), 'mysql')} ADD PARTITION PARTITIONS ${partitionCount};`;
}

export function buildMysqlDropPartitionSql(options: MysqlDropPartitionDdlOptions): string {
    return `ALTER TABLE ${formatQualifiedObjectName(undefined, requireValue(options.schema, 'Schema'), requireValue(options.tableName, 'Table name'), 'mysql')} DROP PARTITION ${formatIdentifierForSql(requireValue(options.partitionName, 'Partition name'), 'mysql')};`;
}

export function buildMysqlCoalescePartitionSql(options: MysqlCoalescePartitionDdlOptions): string {
    const partitionCount = requirePositiveInteger(options.partitionCount, 'Partitions to coalesce');
    return `ALTER TABLE ${formatQualifiedObjectName(undefined, requireValue(options.schema, 'Schema'), requireValue(options.tableName, 'Table name'), 'mysql')} COALESCE PARTITION ${partitionCount};`;
}
