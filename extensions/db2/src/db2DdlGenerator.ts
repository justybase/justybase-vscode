import type {
    DatabaseAdvancedFeatures,
    DatabaseBatchDDLOptions,
    DatabaseBatchDDLResult,
    DatabaseConnection,
    DatabaseDdlColumnInfo,
    DatabaseDdlKeyInfo,
    DatabaseDdlResult
} from '@justybase/contracts';
import type { ConnectionDetails } from '../../../src/types';
import { executeDatabaseQuery } from '../../../src/core/connectionFactory';
import { Db2Connection } from './db2Connection';
import {
    buildAliasDefinitionQuery,
    buildBatchObjectListQuery,
    buildColumnMetadataQuery,
    buildDdlQuery,
    buildFindTableSchemaQuery,
    buildProcedureDefinitionQuery,
    buildTableCheckConstraintsQuery,
    buildKeysInfoQuery,
    buildNicknameDefinitionQuery,
    buildNicknameServerContextQuery,
    resolveNicknameRemoteSchema,
    buildTableCommentQuery,
    buildTableHashDistributionQuery,
    buildTableIndexesQuery,
    buildTableOwnerQuery,
    buildTablePartitionExpressionsQuery,
    buildTablePartitionsQuery,
    buildTableStorageQuery,
    buildTableStatsQuery,
    buildTableTriggersQuery,
    buildViewDefinitionQuery
} from './db2SystemQueries';

interface DdlTextRow {
    DDL?: string | null;
}

interface ColumnRow {
    ATTNAME?: string;
    FORMAT_TYPE?: string;
    DESCRIPTION?: string | null;
    IS_NOT_NULL?: number | string | boolean;
    COLDEFAULT?: string | null;
}

interface KeyRow {
    CONSTNAME?: string;
    TYPE?: string;
    TYPECHAR?: string;
    COLNAME?: string;
    PKSCHEMA?: string;
    PKRELATION?: string;
    PKCOLNAME?: string;
    DELETERULE?: string;
    UPDATERULE?: string;
    ENFORCED?: string | null;
    TRUSTED?: string | null;
    REMARKS?: string | null;
}

interface TextValueRow {
    DESCRIPTION?: string | null;
    OWNER?: string | null;
    SCHEMA?: string | null;
}

interface CheckConstraintRow {
    CONSTNAME?: string;
    TEXT?: string | null;
    ENFORCED?: string | null;
    TRUSTED?: string | null;
    REMARKS?: string | null;
}

interface IndexRow {
    INDEX_SCHEMA?: string | null;
    INDEX_NAME?: string | null;
    COLNAME?: string | null;
    COLSEQ?: number | string;
    COLORDER?: string | null;
    UNIQUERULE?: string | null;
    INDEXTYPE?: string | null;
    COMPRESSION?: string | null;
}

interface TableStorageRow {
    PARTITION_MODE?: string | null;
    PROPERTY?: string | null;
    COMPRESSION?: string | null;
    ROWCOMPMODE?: string | null;
    TABLEORG?: string | null;
    TBSPACE?: string | null;
}

interface PartitionExpressionRow {
    PARTKEYSEQ?: number | string;
    PARTITION_EXPRESSION?: string | null;
    NULLSFIRST?: string | null;
}

interface PartitionRow {
    PARTITION_NAME?: string | null;
    PARTITION_SEQNO?: number | string;
    LOWVALUE?: string | null;
    HIGHVALUE?: string | null;
    LOWINCLUSIVE?: string | null;
    HIGHINCLUSIVE?: string | null;
    TBSPACE?: string | null;
}

interface HashDistributionRow {
    COLNAME?: string | null;
    PARTKEYSEQ?: number | string;
}

interface TriggerRow {
    TRIGGER_SCHEMA?: string | null;
    TRIGGER_NAME?: string | null;
    DEFINITION?: string | null;
}

interface ProcedureDefinitionRow {
    SCHEMA?: string | null;
    PROCEDURE_NAME?: string | null;
    SPECIFICNAME?: string | null;
    PROCEDURE_SIGNATURE?: string | null;
    PROCEDURE_TEXT?: string | null;
}

interface ViewDefinitionRow {
    SCHEMA?: string | null;
    VIEW_NAME?: string | null;
    VIEW_TEXT?: string | null;
}

interface BatchObjectRow {
    OBJECT_SCHEMA?: string | null;
    OBJECT_NAME?: string | null;
    OBJECT_TYPE?: string | null;
}

interface AliasDefinitionRow {
    SCHEMA?: string | null;
    ALIAS_NAME?: string | null;
    TARGET_SCHEMA?: string | null;
    TARGET_NAME?: string | null;
}

interface NicknameDefinitionRow {
    SCHEMA?: string | null;
    NICKNAME_NAME?: string | null;
    SERVERNAME?: string | null;
    REMOTE_SCHEMA?: string | null;
    REMOTE_TABLE?: string | null;
}

interface Db2CheckConstraint {
    name: string;
    text: string;
    enforced: string;
    trusted: string;
    comment: string | null;
}

interface Db2IndexDefinition {
    schema: string;
    name: string;
    unique: boolean;
    keyColumns: string[];
    includeColumns: string[];
    compressed: boolean;
}

interface Db2TableStorageInfo {
    partitionMode: string;
    property: string;
    compression: string;
    rowCompressionMode: string;
    tableOrganization: string;
    tablespace: string;
}

interface Db2PartitionMetadata {
    name: string;
    lowValue: string;
    highValue: string;
    lowInclusive: boolean;
    highInclusive: boolean;
    tablespace: string;
}

interface Db2TriggerDefinition {
    schema: string;
    name: string;
    definition: string;
}

const DB2_RESERVED_KEYWORDS = new Set([
    'ADD', 'ALTER', 'AND', 'AS', 'BY', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CURRENT', 'DATE',
    'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'EXISTS', 'FOREIGN', 'FROM', 'FULL', 'GROUP',
    'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'NOT',
    'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'PROCEDURE', 'REFERENCES', 'RIGHT', 'SCHEMA',
    'SELECT', 'SET', 'TABLE', 'TIME', 'TIMESTAMP', 'UNION', 'UNIQUE', 'UPDATE', 'USER', 'VALUES', 'VIEW',
    'WHERE'
]);

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function formatIdentifier(identifier: string): string {
    if (/^[A-Z_][A-Z0-9_]*$/.test(identifier) && !DB2_RESERVED_KEYWORDS.has(identifier.toUpperCase())) {
        return identifier;
    }
    return quoteIdentifier(identifier);
}

function formatQualifiedName(schema: string, objectName: string): string {
    return `${formatIdentifier(schema)}.${formatIdentifier(objectName)}`;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function ensureStatementTerminated(statement: string): string {
    const trimmed = statement.trim();
    if (trimmed.length === 0) {
        return trimmed;
    }
    return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}

function extractRoutineBaseName(objectName: string): string {
    const signatureStart = objectName.indexOf('(');
    return (signatureStart >= 0 ? objectName.slice(0, signatureStart) : objectName).trim();
}

async function createConnectionFromDetails(connectionDetails: ConnectionDetails): Promise<DatabaseConnection> {
    const connection = new Db2Connection({
        host: connectionDetails.host,
        port: connectionDetails.port,
        database: connectionDetails.database,
        user: connectionDetails.user,
        password: connectionDetails.password,
        options: connectionDetails.options
    });
    await connection.connect();
    return connection;
}

async function readDdl(connection: DatabaseConnection, objectType: string, schema: string, objectName: string): Promise<string> {
    const rows = await executeDatabaseQuery<DdlTextRow>(connection, buildDdlQuery(objectType as 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION', objectName, schema));
    const ddl = rows[0]?.DDL?.trim();
    if (!ddl) {
        throw new Error(`Db2 did not return DDL for ${objectType} ${schema}.${objectName}.`);
    }

    return ensureStatementTerminated(ddl);
}

function rowsToDdlColumns(rows: ColumnRow[]): DatabaseDdlColumnInfo[] {
    return rows.map(row => ({
        name: row.ATTNAME || '',
        description: row.DESCRIPTION ?? null,
        fullTypeName: row.FORMAT_TYPE || '',
        notNull: row.IS_NOT_NULL === 1 || row.IS_NOT_NULL === true || row.IS_NOT_NULL === '1',
        defaultValue: row.COLDEFAULT ?? null
    }));
}

function rowsToKeyInfoMap(rows: KeyRow[]): Map<string, DatabaseDdlKeyInfo> {
    const keys = new Map<string, DatabaseDdlKeyInfo>();

    for (const row of rows) {
        const keyName = row.CONSTNAME || `KEY_${keys.size + 1}`;
        const existing = keys.get(keyName) ?? {
            type: row.TYPE || '',
            typeChar: row.TYPECHAR || '',
            columns: [],
            pkDatabase: null,
            pkSchema: row.PKSCHEMA || null,
            pkRelation: row.PKRELATION || null,
            pkColumns: [],
            updateType: row.UPDATERULE || '',
            deleteType: row.DELETERULE || '',
            enforced: row.ENFORCED?.trim().toUpperCase() || '',
            trusted: row.TRUSTED?.trim().toUpperCase() || '',
            comment: row.REMARKS?.trim() || null
        };

        if (row.COLNAME) {
            existing.columns.push(row.COLNAME);
        }
        if (row.PKCOLNAME) {
            existing.pkColumns.push(row.PKCOLNAME);
        }

        keys.set(keyName, existing);
    }

    return keys;
}

async function getDb2Columns(connection: DatabaseConnection, schema: string, tableName: string): Promise<DatabaseDdlColumnInfo[]> {
    const rows = await executeDatabaseQuery<ColumnRow>(connection, buildColumnMetadataQuery(schema, tableName));
    return rowsToDdlColumns(rows);
}

async function getDb2KeysInfo(connection: DatabaseConnection, schema: string, tableName: string): Promise<Map<string, DatabaseDdlKeyInfo>> {
    const rows = await executeDatabaseQuery<KeyRow>(connection, buildKeysInfoQuery(schema, tableName));
    return rowsToKeyInfoMap(rows);
}

async function getDb2TableComment(connection: DatabaseConnection, schema: string, tableName: string): Promise<string | null> {
    const rows = await executeDatabaseQuery<TextValueRow>(connection, buildTableCommentQuery(schema, tableName));
    return rows[0]?.DESCRIPTION ?? null;
}

async function getDb2TableOwner(connection: DatabaseConnection, schema: string, tableName: string): Promise<string | null> {
    const rows = await executeDatabaseQuery<TextValueRow>(connection, buildTableOwnerQuery(schema, tableName));
    return rows[0]?.OWNER ?? null;
}

async function getDb2CheckConstraints(connection: DatabaseConnection, schema: string, tableName: string): Promise<Db2CheckConstraint[]> {
    const rows = await executeDatabaseQuery<CheckConstraintRow>(connection, buildTableCheckConstraintsQuery(schema, tableName));
    return rows
        .map(row => ({
            name: row.CONSTNAME?.trim() || '',
            text: row.TEXT?.trim() || '',
            enforced: row.ENFORCED?.trim().toUpperCase() || '',
            trusted: row.TRUSTED?.trim().toUpperCase() || '',
            comment: row.REMARKS?.trim() || null
        }))
        .filter(row => row.name.length > 0 && row.text.length > 0);
}

function mapTableStorageInfo(row: TableStorageRow | undefined): Db2TableStorageInfo | undefined {
    if (!row) {
        return undefined;
    }

    return {
        partitionMode: row.PARTITION_MODE?.trim().toUpperCase() || '',
        property: row.PROPERTY?.trim().toUpperCase() || '',
        compression: row.COMPRESSION?.trim().toUpperCase() || '',
        rowCompressionMode: row.ROWCOMPMODE?.trim().toUpperCase() || '',
        tableOrganization: row.TABLEORG?.trim().toUpperCase() || '',
        tablespace: row.TBSPACE?.trim() || ''
    };
}

async function getDb2TableStorage(connection: DatabaseConnection, schema: string, tableName: string): Promise<Db2TableStorageInfo | undefined> {
    const rows = await executeDatabaseQuery<TableStorageRow>(connection, buildTableStorageQuery(schema, tableName));
    return mapTableStorageInfo(rows[0]);
}

async function getDb2Indexes(connection: DatabaseConnection, schema: string, tableName: string): Promise<Db2IndexDefinition[]> {
    const rows = await executeDatabaseQuery<IndexRow>(connection, buildTableIndexesQuery(schema, tableName));
    const indexes = new Map<string, Db2IndexDefinition>();

    for (const row of rows) {
        const indexName = row.INDEX_NAME?.trim();
        if (!indexName) {
            continue;
        }

        const key = `${row.INDEX_SCHEMA?.trim() || schema}|${indexName}`;
        const existing = indexes.get(key) ?? {
            schema: row.INDEX_SCHEMA?.trim() || schema,
            name: indexName,
            unique: row.UNIQUERULE?.trim().toUpperCase() === 'U',
            keyColumns: [],
            includeColumns: [],
            compressed: row.COMPRESSION?.trim().toUpperCase() === 'Y'
        };

        const columnName = row.COLNAME?.trim();
        if (!columnName) {
            indexes.set(key, existing);
            continue;
        }

        const normalizedOrder = row.COLORDER?.trim().toUpperCase() || 'A';
        if (normalizedOrder === 'I') {
            existing.includeColumns.push(formatIdentifier(columnName));
        } else {
            existing.keyColumns.push(
                normalizedOrder === 'D'
                    ? `${formatIdentifier(columnName)} DESC`
                    : formatIdentifier(columnName)
            );
        }

        indexes.set(key, existing);
    }

    return Array.from(indexes.values()).filter(index => index.keyColumns.length > 0);
}

async function getDb2PartitionExpressions(connection: DatabaseConnection, schema: string, tableName: string): Promise<string[]> {
    const rows = await executeDatabaseQuery<PartitionExpressionRow>(connection, buildTablePartitionExpressionsQuery(schema, tableName));
    return rows
        .map(row => {
            const expression = row.PARTITION_EXPRESSION?.trim() || '';
            if (!expression) {
                return '';
            }
            return row.NULLSFIRST?.trim().toUpperCase() === 'N'
                ? `${expression} NULLS LAST`
                : expression;
        })
        .filter(expression => expression.length > 0);
}

async function getDb2Partitions(connection: DatabaseConnection, schema: string, tableName: string): Promise<Db2PartitionMetadata[]> {
    const rows = await executeDatabaseQuery<PartitionRow>(connection, buildTablePartitionsQuery(schema, tableName));
    return rows.map(row => ({
        name: row.PARTITION_NAME?.trim() || '',
        lowValue: row.LOWVALUE?.trim() || '',
        highValue: row.HIGHVALUE?.trim() || '',
        lowInclusive: (row.LOWINCLUSIVE?.trim().toUpperCase() || '') === 'Y',
        highInclusive: (row.HIGHINCLUSIVE?.trim().toUpperCase() || '') === 'Y',
        tablespace: row.TBSPACE?.trim() || ''
    }));
}

async function getDb2DistributionInfo(connection: DatabaseConnection, schema: string, tableName: string): Promise<string[]> {
    const rows = await executeDatabaseQuery<HashDistributionRow>(connection, buildTableHashDistributionQuery(schema, tableName));
    return rows
        .map(row => row.COLNAME?.trim() || '')
        .filter(columnName => columnName.length > 0);
}

async function getDb2Triggers(connection: DatabaseConnection, schema: string, tableName: string): Promise<Db2TriggerDefinition[]> {
    const rows = await executeDatabaseQuery<TriggerRow>(connection, buildTableTriggersQuery(schema, tableName));
    return rows
        .map(row => ({
            schema: row.TRIGGER_SCHEMA?.trim() || schema,
            name: row.TRIGGER_NAME?.trim() || '',
            definition: row.DEFINITION?.trim() || ''
        }))
        .filter(row => row.name.length > 0 && row.definition.length > 0);
}

async function getDb2ProcedureDefinition(
    connection: DatabaseConnection,
    schema: string,
    procedureSignatureOrName: string
): Promise<ProcedureDefinitionRow | undefined> {
    const rows = await executeDatabaseQuery<ProcedureDefinitionRow>(
        connection,
        buildProcedureDefinitionQuery(schema, procedureSignatureOrName)
    );
    return rows[0];
}

async function getDb2ViewDefinition(
    connection: DatabaseConnection,
    schema: string,
    viewName: string
): Promise<ViewDefinitionRow | undefined> {
    const rows = await executeDatabaseQuery<ViewDefinitionRow>(
        connection,
        buildViewDefinitionQuery(schema, viewName)
    );
    return rows[0];
}

function mapReferentialAction(rule: string | undefined): string | undefined {
    const normalizedRule = rule?.trim().toUpperCase();
    switch (normalizedRule) {
        case 'A':
        case 'NO ACTION':
            return 'NO ACTION';
        case 'C':
        case 'CASCADE':
            return 'CASCADE';
        case 'N':
        case 'SET NULL':
            return 'SET NULL';
        case 'R':
        case 'RESTRICT':
            return 'RESTRICT';
        default:
            return undefined;
    }
}

function buildConstraintStateClause(enforced?: string, trusted?: string): string {
    const clauses: string[] = [];
    switch ((enforced ?? '').trim().toUpperCase()) {
        case 'Y':
            clauses.push('ENFORCED');
            break;
        case 'N':
            clauses.push('NOT ENFORCED');
            break;
    }

    switch ((trusted ?? '').trim().toUpperCase()) {
        case 'Y':
            clauses.push('TRUSTED');
            break;
        case 'N':
            clauses.push('NOT TRUSTED');
            break;
    }

    return clauses.length > 0 ? ` ${clauses.join(' ')}` : '';
}

function buildConstraintCommentStatement(
    schema: string,
    tableName: string,
    constraintName: string,
    comment?: string | null
): string | undefined {
    const normalizedComment = comment?.trim();
    if (!normalizedComment) {
        return undefined;
    }

    return `COMMENT ON CONSTRAINT ${formatQualifiedName(schema, tableName)}.${formatIdentifier(constraintName)} IS ${quoteLiteral(normalizedComment)};`;
}

function buildConstraintStatements(schema: string, tableName: string, keysInfo: Map<string, DatabaseDdlKeyInfo>): string[] {
    const tableIdentifier = formatQualifiedName(schema, tableName);
    const statements: string[] = [];

    for (const [name, keyInfo] of keysInfo) {
        const columns = keyInfo.columns.map(column => formatIdentifier(column)).join(', ');
        const normalizedType = keyInfo.type.toUpperCase();
        const constraintState = buildConstraintStateClause(keyInfo.enforced, keyInfo.trusted);
        let clause: string | undefined;

        if ((keyInfo.typeChar || '').toUpperCase() === 'P' || normalizedType.includes('PRIMARY')) {
            clause = `ALTER TABLE ${tableIdentifier} ADD CONSTRAINT ${formatIdentifier(name)} PRIMARY KEY (${columns})${constraintState};`;
        } else if ((keyInfo.typeChar || '').toUpperCase() === 'U' || normalizedType.includes('UNIQUE')) {
            clause = `ALTER TABLE ${tableIdentifier} ADD CONSTRAINT ${formatIdentifier(name)} UNIQUE (${columns})${constraintState};`;
        } else if ((keyInfo.typeChar || '').toUpperCase() === 'F' || normalizedType.includes('FOREIGN')) {
            const referencedSchema = keyInfo.pkSchema ? formatIdentifier(keyInfo.pkSchema) : undefined;
            const referencedTable = keyInfo.pkRelation ? formatIdentifier(keyInfo.pkRelation) : undefined;
            if (!referencedSchema || !referencedTable || keyInfo.pkColumns.length === 0) {
                continue;
            }

            const referencedColumns = keyInfo.pkColumns.map(column => formatIdentifier(column)).join(', ');
            const deleteRule = mapReferentialAction(keyInfo.deleteType);
            const updateRule = mapReferentialAction(keyInfo.updateType);
            clause = `ALTER TABLE ${tableIdentifier} ADD CONSTRAINT ${formatIdentifier(name)} FOREIGN KEY (${columns}) REFERENCES ${referencedSchema}.${referencedTable} (${referencedColumns})`;
            if (deleteRule) {
                clause += ` ON DELETE ${deleteRule}`;
            }
            if (updateRule) {
                clause += ` ON UPDATE ${updateRule}`;
            }
            clause += `${constraintState};`;
        }

        if (!clause) {
            continue;
        }

        statements.push(clause);
        const commentStatement = buildConstraintCommentStatement(schema, tableName, name, keyInfo.comment);
        if (commentStatement) {
            statements.push(commentStatement);
        }
    }

    return statements;
}

function normalizeCheckConstraintText(text: string): string {
    const normalized = text.trim().replace(/;+\s*$/, '');
    if (/^CHECK\b/i.test(normalized)) {
        return normalized;
    }
    if (normalized.startsWith('(')) {
        return `CHECK ${normalized}`;
    }
    return `CHECK (${normalized})`;
}

function buildCheckConstraintStatements(
    schema: string,
    tableName: string,
    checkConstraints: readonly Db2CheckConstraint[]
): string[] {
    const tableIdentifier = formatQualifiedName(schema, tableName);
    const statements: string[] = [];

    for (const constraint of checkConstraints) {
        statements.push(
            `ALTER TABLE ${tableIdentifier} ADD CONSTRAINT ${formatIdentifier(constraint.name)} ${normalizeCheckConstraintText(constraint.text)}${buildConstraintStateClause(constraint.enforced, constraint.trusted)};`
        );

        const commentStatement = buildConstraintCommentStatement(schema, tableName, constraint.name, constraint.comment);
        if (commentStatement) {
            statements.push(commentStatement);
        }
    }

    return statements;
}

function buildIndexStatements(schema: string, tableName: string, indexes: readonly Db2IndexDefinition[]): string[] {
    const tableIdentifier = formatQualifiedName(schema, tableName);
    return indexes.map(index => {
        const uniqueKeyword = index.unique ? 'UNIQUE ' : '';
        const includeClause = index.includeColumns.length > 0
            ? ` INCLUDE (${index.includeColumns.join(', ')})`
            : '';
        const compressionClause = index.compressed ? ' COMPRESS YES' : '';
        return `CREATE ${uniqueKeyword}INDEX ${formatQualifiedName(index.schema, index.name)} ON ${tableIdentifier} (${index.keyColumns.join(', ')})${includeClause}${compressionClause};`;
    });
}

function wrapPartitionBoundaryValue(value: string, multiKey: boolean): string {
    const trimmed = value.trim();
    if (!multiKey || trimmed.length === 0 || (trimmed.startsWith('(') && trimmed.endsWith(')'))) {
        return trimmed;
    }
    return `(${trimmed})`;
}

function buildPartitionClause(
    partitionExpressions: readonly string[],
    partitions: readonly Db2PartitionMetadata[]
): string | undefined {
    if (partitionExpressions.length === 0 || partitions.length === 0) {
        return undefined;
    }

    const multiKey = partitionExpressions.length > 1;
    const partitionDefinitions: string[] = [];

    for (const partition of partitions) {
        if (!partition.name || !partition.lowValue || !partition.highValue) {
            return undefined;
        }

        let clause = `PARTITION ${formatIdentifier(partition.name)} STARTING FROM ${wrapPartitionBoundaryValue(partition.lowValue, multiKey)} ${partition.lowInclusive ? 'INCLUSIVE' : 'EXCLUSIVE'} ENDING AT ${wrapPartitionBoundaryValue(partition.highValue, multiKey)} ${partition.highInclusive ? 'INCLUSIVE' : 'EXCLUSIVE'}`;
        if (partition.tablespace) {
            clause += ` IN ${formatIdentifier(partition.tablespace)}`;
        }
        partitionDefinitions.push(clause);
    }

    return `PARTITION BY RANGE(${partitionExpressions.join(', ')})\n(${partitionDefinitions.join(',\n')})`;
}

function buildCompressionClause(tableStorage?: Db2TableStorageInfo): string | undefined {
    if (!tableStorage) {
        return undefined;
    }

    return tableStorage.compression === 'B' || tableStorage.compression === 'R' || tableStorage.compression === 'V'
        ? 'COMPRESS YES'
        : 'COMPRESS NO';
}

function buildTableOptionClauses(
    distributionColumns: readonly string[],
    organizeColumns: readonly string[],
    tableStorage?: Db2TableStorageInfo,
    partitionClause?: string
): string[] {
    const clauses: string[] = [];

    if (distributionColumns.length > 0) {
        clauses.push(`DISTRIBUTE BY HASH (${distributionColumns.map(column => formatIdentifier(column)).join(', ')})`);
    } else if (tableStorage?.partitionMode === 'H' && tableStorage.property === 'Y') {
        clauses.push('DISTRIBUTE BY RANDOM');
    }

    if (organizeColumns.length > 0) {
        clauses.unshift(`ORGANIZE BY DIMENSIONS (${organizeColumns.map(column => formatIdentifier(column)).join(', ')})`);
    } else if (tableStorage?.tableOrganization === 'C' || tableStorage?.tableOrganization === 'R') {
        let organizeClause = tableStorage.tableOrganization === 'C'
            ? 'ORGANIZE BY COLUMN'
            : 'ORGANIZE BY ROW';
        if (tableStorage.tablespace) {
            organizeClause += ` IN ${formatIdentifier(tableStorage.tablespace)}`;
        }
        clauses.unshift(organizeClause);
    }

    const compressionClause = buildCompressionClause(tableStorage);
    if (compressionClause) {
        clauses.push(compressionClause);
    }

    if (partitionClause) {
        clauses.push(partitionClause);
    }

    return clauses;
}

function buildFallbackMetadataComments(
    tableStorage: Db2TableStorageInfo | undefined,
    distributionColumns: readonly string[],
    partitionExpressions: readonly string[],
    partitions: readonly Db2PartitionMetadata[]
): string[] {
    const comments: string[] = [];

    if (tableStorage?.partitionMode === 'H' && tableStorage.property !== 'Y' && distributionColumns.length === 0) {
        comments.push('-- Distribution metadata indicates hash distribution, but the hash key columns were not available from fallback catalog queries.');
    }

    if (partitionExpressions.length > 0) {
        comments.push(`-- Partition key expressions: ${partitionExpressions.join(', ')}`);
    }

    for (const partition of partitions) {
        const lowMarker = partition.lowInclusive ? '[' : '(';
        const highMarker = partition.highInclusive ? ']' : ')';
        const lowValue = partition.lowValue || '-INF';
        const highValue = partition.highValue || '+INF';
        comments.push(
            `-- Partition ${partition.name || '<unnamed>'}: ${lowMarker}${lowValue}, ${highValue}${highMarker}`
        );
    }

    return comments;
}

function buildTriggerStatements(triggers: readonly Db2TriggerDefinition[]): string[] {
    return triggers.map(trigger => ensureStatementTerminated(trigger.definition));
}

function buildCommentClauses(schema: string, tableName: string, columns: DatabaseDdlColumnInfo[], tableComment?: string | null): string[] {
    const commentStatements: string[] = [];
    if (tableComment && tableComment.trim().length > 0) {
        commentStatements.push(
            `COMMENT ON TABLE ${formatQualifiedName(schema, tableName)} IS ${quoteLiteral(tableComment.trim())};`
        );
    }

    for (const column of columns) {
        const description = column.description?.trim();
        if (!description) {
            continue;
        }

        commentStatements.push(
            `COMMENT ON COLUMN ${formatQualifiedName(schema, tableName)}.${formatIdentifier(column.name)} IS ${quoteLiteral(description)};`
        );
    }

    return commentStatements;
}

function buildDb2TableDDLFromCache(
    schema: string,
    tableName: string,
    columns: DatabaseDdlColumnInfo[],
    distributionColumns: readonly string[],
    organizeColumns: readonly string[],
    keysInfo: Map<string, DatabaseDdlKeyInfo>,
    tableComment?: string | null,
    tableStorage?: Db2TableStorageInfo,
    checkConstraints: readonly Db2CheckConstraint[] = [],
    indexes: readonly Db2IndexDefinition[] = [],
    partitionExpressions: readonly string[] = [],
    partitions: readonly Db2PartitionMetadata[] = [],
    triggers: readonly Db2TriggerDefinition[] = []
): string {
    const columnDefinitions = columns.map(column => {
        const parts = [formatIdentifier(column.name), column.fullTypeName];
        if (column.notNull) {
            parts.push('NOT NULL');
        }
        if (column.defaultValue) {
            parts.push(`DEFAULT ${column.defaultValue}`);
        }
        return parts.join(' ');
    });

    const partitionClause = buildPartitionClause(partitionExpressions, partitions);
    const optionClauses = buildTableOptionClauses(
        distributionColumns,
        organizeColumns,
        tableStorage,
        partitionClause
    );
    const createTableStatement = [
        `CREATE TABLE ${formatQualifiedName(schema, tableName)} (\n    ${columnDefinitions.join(',\n    ')}\n)`,
        ...optionClauses
    ].join('\n') + ';';
    const fallbackMetadataComments = partitionClause
        ? buildFallbackMetadataComments(tableStorage, distributionColumns, [], [])
        : buildFallbackMetadataComments(tableStorage, distributionColumns, partitionExpressions, partitions);
    const ddlStatements = [
        createTableStatement,
        ...buildConstraintStatements(schema, tableName, keysInfo),
        ...buildCheckConstraintStatements(schema, tableName, checkConstraints),
        ...fallbackMetadataComments,
        ...buildIndexStatements(schema, tableName, indexes),
        ...buildCommentClauses(schema, tableName, columns, tableComment),
        ...buildTriggerStatements(triggers)
    ];

    return ddlStatements.join('\n');
}

async function loadOptionalTableMetadata<T>(loader: () => Promise<T>, fallbackValue: T): Promise<T> {
    try {
        return await loader();
    } catch {
        return fallbackValue;
    }
}

async function buildFallbackTableDDL(connection: DatabaseConnection, schema: string, tableName: string): Promise<string> {
    const columns = await getDb2Columns(connection, schema, tableName);
    if (columns.length === 0) {
        throw new Error(`Db2 did not return column metadata for TABLE ${schema}.${tableName}.`);
    }

    const [distributionColumns, keysInfo, tableComment, tableStorage, checkConstraints, indexes, partitionExpressions, partitions, triggers] = await Promise.all([
        loadOptionalTableMetadata(() => getDb2DistributionInfo(connection, schema, tableName), [] as string[]),
        loadOptionalTableMetadata(() => getDb2KeysInfo(connection, schema, tableName), new Map<string, DatabaseDdlKeyInfo>()),
        loadOptionalTableMetadata(() => getDb2TableComment(connection, schema, tableName), null as string | null),
        loadOptionalTableMetadata(() => getDb2TableStorage(connection, schema, tableName), undefined as Db2TableStorageInfo | undefined),
        loadOptionalTableMetadata(() => getDb2CheckConstraints(connection, schema, tableName), [] as Db2CheckConstraint[]),
        loadOptionalTableMetadata(() => getDb2Indexes(connection, schema, tableName), [] as Db2IndexDefinition[]),
        loadOptionalTableMetadata(() => getDb2PartitionExpressions(connection, schema, tableName), [] as string[]),
        loadOptionalTableMetadata(() => getDb2Partitions(connection, schema, tableName), [] as Db2PartitionMetadata[]),
        loadOptionalTableMetadata(() => getDb2Triggers(connection, schema, tableName), [] as Db2TriggerDefinition[])
    ]);

    return buildDb2TableDDLFromCache(
        schema,
        tableName,
        columns,
        distributionColumns,
        [],
        keysInfo,
        tableComment,
        tableStorage,
        checkConstraints,
        indexes,
        partitionExpressions,
        partitions,
        triggers
    );
}

async function buildAliasDDL(connection: DatabaseConnection, schema: string, aliasName: string): Promise<string> {
    const rows = await executeDatabaseQuery<AliasDefinitionRow>(connection, buildAliasDefinitionQuery(schema, aliasName));
    const alias = rows[0];
    const targetSchema = alias?.TARGET_SCHEMA?.trim();
    const targetName = alias?.TARGET_NAME?.trim();
    if (!targetSchema || !targetName) {
        throw new Error(`Db2 did not return an alias target for ${schema}.${aliasName}.`);
    }

    return `CREATE ALIAS ${formatQualifiedName(schema, aliasName)} FOR ${formatQualifiedName(targetSchema, targetName)};`;
}

async function buildNicknameDDL(connection: DatabaseConnection, schema: string, nicknameName: string): Promise<string> {
    const rows = await executeDatabaseQuery<NicknameDefinitionRow>(connection, buildNicknameDefinitionQuery(schema, nicknameName));
    const nickname = rows[0];
    const serverName = nickname?.SERVERNAME?.trim();
    const remoteTable = nickname?.REMOTE_TABLE?.trim();
    if (!serverName || !remoteTable) {
        throw new Error(`Db2 did not return a nickname target for ${schema}.${nicknameName}.`);
    }

    const serverContextRows = await executeDatabaseQuery(
        connection,
        buildNicknameServerContextQuery(serverName)
    );
    const remoteSchema = resolveNicknameRemoteSchema(nickname.REMOTE_SCHEMA ?? undefined, serverContextRows[0]);
    const remoteParts = remoteSchema
        ? [formatIdentifier(serverName), formatIdentifier(remoteSchema), formatIdentifier(remoteTable)]
        : [formatIdentifier(serverName), formatIdentifier(remoteTable)];
    return `CREATE NICKNAME ${formatQualifiedName(schema, nicknameName)} FOR ${remoteParts.join('.')};`;
}

async function buildProcedureDDL(connection: DatabaseConnection, schema: string, procedureSignatureOrName: string): Promise<string> {
    const routineName = extractRoutineBaseName(procedureSignatureOrName);
    try {
        return await readDdl(connection, 'PROCEDURE', schema, routineName);
    } catch {
        const procedure = await getDb2ProcedureDefinition(connection, schema, procedureSignatureOrName);
        const procedureText = procedure?.PROCEDURE_TEXT?.trim();
        if (!procedureText) {
            throw new Error(`Db2 did not return DDL for PROCEDURE ${schema}.${procedureSignatureOrName}.`);
        }

        return [
            `SET SCHEMA ${formatIdentifier(schema)};`,
            ensureStatementTerminated(procedureText)
        ].join('\n');
    }
}

async function buildViewDDL(connection: DatabaseConnection, schema: string, viewName: string): Promise<string> {
    try {
        return await readDdl(connection, 'VIEW', schema, viewName);
    } catch {
        const view = await getDb2ViewDefinition(connection, schema, viewName);
        const viewText = view?.VIEW_TEXT?.trim();
        if (!viewText) {
            throw new Error(`Db2 did not return DDL for VIEW ${schema}.${viewName}.`);
        }

        if (/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i.test(viewText)) {
            return ensureStatementTerminated(viewText);
        }

        const normalizedViewText = viewText.replace(/;+\s*$/, '');
        return ensureStatementTerminated(`CREATE VIEW ${formatQualifiedName(schema, viewName)} AS ${normalizedViewText}`);
    }
}

async function generateObjectDDL(connection: DatabaseConnection, schema: string, objectName: string, objectType: string): Promise<string> {
    const normalizedType = objectType.trim().toUpperCase();
    if (normalizedType === 'TABLE') {
        try {
            return await readDdl(connection, normalizedType, schema, objectName);
        } catch {
            return buildFallbackTableDDL(connection, schema, objectName);
        }
    }

    if (normalizedType === 'ALIAS') {
        return buildAliasDDL(connection, schema, objectName);
    }

    if (normalizedType === 'NICKNAME') {
        return buildNicknameDDL(connection, schema, objectName);
    }

    if (normalizedType === 'PROCEDURE') {
        return buildProcedureDDL(connection, schema, objectName);
    }

    if (normalizedType === 'VIEW') {
        return buildViewDDL(connection, schema, objectName);
    }

    return readDdl(connection, normalizedType, schema, objectName);
}
import { db2ImportTypeMapper } from './db2ImportTypeMapper';
import { db2MaintenanceProvider } from './db2MaintenanceProvider';
import { db2CopilotReferenceProvider } from './db2ReferenceProvider';
import { db2SessionMonitorProvider } from './db2SessionMonitorProvider';
import { db2TuningAdvisor } from './db2TuningAdvisor';

export const db2AdvancedFeatures: DatabaseAdvancedFeatures = {
    importTypeMapper: db2ImportTypeMapper,
    tuningAdvisor: db2TuningAdvisor,
    maintenance: db2MaintenanceProvider,
    copilotReferenceProvider: db2CopilotReferenceProvider,
    sessionMonitor: db2SessionMonitorProvider,
    ddl: {
        quoteNameIfNeeded(name: string): string {
            return formatIdentifier(name);
        },
        buildFindTableSchemaQuery(_database: string, tableName: string): string {
            return buildFindTableSchemaQuery(tableName);
        },
        buildTableStatsQuery(_database: string, schema: string, tableName: string): string {
            return buildTableStatsQuery(schema, tableName);
        },
        buildSkewCheckQuery(qualifiedTableName: string): string {
            return `SELECT 0 AS DATASLICEID, COUNT(*) AS ROW_COUNT FROM ${qualifiedTableName}`;
        },
        async getColumns(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<DatabaseDdlColumnInfo[]> {
            return getDb2Columns(connection, schema, tableName);
        },
        async getDistributionInfo(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<string[]> {
            return getDb2DistributionInfo(connection, schema, tableName);
        },
        async getOrganizeInfo(): Promise<string[]> {
            return [];
        },
        async getKeysInfo(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<Map<string, DatabaseDdlKeyInfo>> {
            return getDb2KeysInfo(connection, schema, tableName);
        },
        async getTableComment(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<string | null> {
            return getDb2TableComment(connection, schema, tableName);
        },
        async getTableOwner(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<string | null> {
            return getDb2TableOwner(connection, schema, tableName);
        },
        async generateTableDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            tableName: string
        ): Promise<string> {
            return generateObjectDDL(connection, schema, tableName, 'TABLE');
        },
        buildTableDDLFromCache(
            _database: string,
            schema: string,
            tableName: string,
            columns: DatabaseDdlColumnInfo[],
            distributionColumns: string[],
            organizeColumns: string[],
            keysInfo: Map<string, DatabaseDdlKeyInfo>,
            tableComment?: string | null
        ): string {
            return buildDb2TableDDLFromCache(
                schema,
                tableName,
                columns,
                distributionColumns,
                organizeColumns,
                keysInfo,
                tableComment
            );
        },
        async generateViewDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            viewName: string
        ): Promise<string> {
            return generateObjectDDL(connection, schema, viewName, 'VIEW');
        },
        async generateProcedureDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            procSignature: string
        ): Promise<string> {
            return generateObjectDDL(connection, schema, procSignature, 'PROCEDURE');
        },
        async generateExternalTableDDL(): Promise<string> {
            throw new Error('Db2 LUW external table DDL generation is not implemented in the generic extension layer.');
        },
        async generateSynonymDDL(
            connection: DatabaseConnection,
            _database: string,
            schema: string,
            synonymName: string
        ): Promise<string> {
            try {
                return await buildAliasDDL(connection, schema, synonymName);
            } catch {
                return buildNicknameDDL(connection, schema, synonymName);
            }
        },
        async generateBatchDDL(options: DatabaseBatchDDLOptions): Promise<DatabaseBatchDDLResult> {
            const connection = await createConnectionFromDetails(options.connectionDetails);
            try {
                const rows = await executeDatabaseQuery<BatchObjectRow>(
                    connection,
                    buildBatchObjectListQuery(options.schema, options.objectTypes)
                );
                const ddlStatements: string[] = [];

                for (const row of rows) {
                    const objectSchema = row.OBJECT_SCHEMA?.trim();
                    const objectName = row.OBJECT_NAME?.trim();
                    const objectType = row.OBJECT_TYPE?.trim().toUpperCase();

                    if (!objectSchema || !objectName || !objectType) {
                        continue;
                    }

                    ddlStatements.push(await generateObjectDDL(connection, objectSchema, objectName, objectType));
                }

                return {
                    success: ddlStatements.length > 0,
                    ddlCode: ddlStatements.join('\n\n'),
                    objectCount: ddlStatements.length,
                    errors: ddlStatements.length > 0 ? [] : ['No Db2 objects matched the requested filters.'],
                    skipped: 0
                };
            } finally {
                await connection.close();
            }
        },
        async generateDDL(
            connectionDetails: ConnectionDetails,
            _database: string,
            schema: string,
            objectName: string,
            objectType: string
        ): Promise<DatabaseDdlResult> {
            const connection = await createConnectionFromDetails(connectionDetails);
            try {
                const normalizedObjectType = objectType.trim().toUpperCase();
                const ddlCode = await generateObjectDDL(connection, schema, objectName, normalizedObjectType);
                return {
                    success: true,
                    ddlCode,
                    objectInfo: {
                        database: connectionDetails.database,
                        schema,
                        objectName,
                        objectType: normalizedObjectType
                    },
                    note: normalizedObjectType === 'TABLE'
                        ? 'Db2 table DDL uses DBMS_METADATA.GET_DDL when available and falls back to catalog reconstruction.'
                        : normalizedObjectType === 'ALIAS' || normalizedObjectType === 'NICKNAME'
                            ? 'Db2 federated object DDL was reconstructed from SYSCAT metadata.'
                            : 'Db2 DDL was retrieved via DBMS_METADATA.GET_DDL.'
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                };
            } finally {
                await connection.close();
            }
        }
    }
};
