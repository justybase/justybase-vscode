/**
 * Schema Commands - Menu SQL Generators
 *
 * Pure SQL builders for schema-tree context actions (count rows, duplicate
 * search, CTAS, routine calls, index DDL, storage options, value search).
 * Ported from the Tauri SchemaBrowser helpers so both shells generate the
 * same dialect-specific statements; all builders are unit-testable without
 * a connection.
 */

import type { DatabaseKind } from '../../contracts/database';
import { formatIdentifierForSql, formatQualifiedObjectName } from '../../utils/identifierUtils';

export function countRowsSql(qualifiedName: string): string {
    return `SELECT COUNT(*) AS row_count FROM ${qualifiedName};`;
}

export function duplicateRowsSql(qualifiedName: string, quotedColumns: string): string {
    const columns = quotedColumns.trim();
    if (!columns) throw new Error('Choose at least one column to find duplicate values.');
    return `SELECT ${columns}, COUNT(*) AS duplicate_count\nFROM ${qualifiedName}\nGROUP BY ${columns}\nHAVING COUNT(*) > 1\nORDER BY duplicate_count DESC;`;
}

export interface IndexDesignOptions {
    unique?: boolean;
    method?: string;
    includeColumns?: string;
    predicate?: string;
    concurrently?: boolean;
    clustered?: boolean;
    compress?: boolean;
    pctFree?: number;
}

export type AlterColumnChange =
    | { operation: 'setType'; dataType: string; using?: string }
    | { operation: 'setNotNull' }
    | { operation: 'dropNotNull' }
    | { operation: 'setDefault'; expression: string }
    | { operation: 'dropDefault' };

export type PostgresTableStorageChange =
    | { operation: 'setFillfactor'; value: number }
    | { operation: 'resetFillfactor' }
    | { operation: 'setTablespace'; name: string };

export function postgresTableStorageSql(qualifiedTableName: string, change: PostgresTableStorageChange): string {
    if (change.operation === 'setFillfactor') {
        if (!Number.isInteger(change.value) || change.value < 10 || change.value > 100) {
            throw new Error('PostgreSQL table fillfactor must be a whole number from 10 to 100.');
        }
        return `ALTER TABLE ${qualifiedTableName} SET (fillfactor = ${change.value});`;
    }
    if (change.operation === 'resetFillfactor') return `ALTER TABLE ${qualifiedTableName} RESET (fillfactor);`;
    const tablespace = change.name.trim();
    if (!/^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(tablespace)) throw new Error('Enter a valid PostgreSQL tablespace name.');
    return `ALTER TABLE ${qualifiedTableName} SET TABLESPACE "${tablespace.replace(/"/g, '""')}";`;
}

export function isSafeSqlDataType(dataType: string): boolean {
    const tokens = dataType.trim().split(/\s+/);
    return tokens.length > 0 && tokens.every(token =>
        /^(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$#]*)(?:\.(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$#]*))?(?:\(\d+(?:,\d+)*\))?(?:\[\])*$/u.test(token),
    );
}

export function isSafeSqliteAddColumnDefault(expression: string): boolean {
    return /^(?:NULL|TRUE|FALSE|-?\d+(?:\.\d+)?|'(?:[^']|'')*'|X'[\da-f]*')$/i.test(expression.trim());
}

export interface SchemaValueSearchTarget {
    location: string;
    qualifiedTableName: string;
    quotedColumnName: string;
    dataType: string;
}

const SCHEMA_VALUE_SEARCH_KINDS: ReadonlySet<string> = new Set(['netezza', 'postgresql', 'db2', 'sqlite', 'duckdb']);
export type SchemaValueSearchKind = 'netezza' | 'postgresql' | 'db2' | 'sqlite' | 'duckdb';
const NUMERIC_COLUMN_TYPE = /\b(?:BYTEINT|TINYINT|SMALLINT|INTEGER|INT[248]?|BIGINT|HUGEINT|UHUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|DECIMAL|NUMERIC|NUMBER|REAL|DOUBLE|FLOAT[48]?|DECFLOAT|MONEY)\b/i;
const TEXT_COLUMN_TYPE = /\b(?:CHAR|CHARACTER|NCHAR|NVARCHAR|VARCHAR|VARYING|TEXT|GRAPHIC|VARGRAPHIC)\b/i;
const NUMERIC_LITERAL = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

export function supportsSchemaValueSearch(kind: string | undefined): kind is SchemaValueSearchKind {
    return kind != null && SCHEMA_VALUE_SEARCH_KINDS.has(kind);
}

function sqlStringLiteral(value: string, kind: SchemaValueSearchKind): string {
    const escaped = kind === 'netezza' ? value.replace(/\\/g, '\\\\') : value;
    return `'${escaped.replace(/'/g, "''")}'`;
}

function schemaSearchCastType(kind: SchemaValueSearchKind): string {
    switch (kind) {
        case 'netezza': return 'VARCHAR(64000)';
        case 'db2': return 'VARCHAR(32672)';
        case 'postgresql': case 'sqlite': return 'TEXT';
        case 'duckdb': return 'VARCHAR';
        default: throw new Error('Value search is supported for Netezza, PostgreSQL, Db2, SQLite, and DuckDB.');
    }
}

function isSchemaTextType(kind: SchemaValueSearchKind, dataType: string): boolean {
    if (/FOR BIT DATA|\b(?:CLOB|DBCLOB|NCLOB|XML)\b/i.test(dataType)) return false;
    if (kind === 'netezza' && /\b(?:NCHAR|NVARCHAR|NATIONAL\s+CHAR(?:ACTER)?(?:\s+VARYING)?)\b/i.test(dataType)) return false;
    if (TEXT_COLUMN_TYPE.test(dataType)) return true;
    return (kind === 'postgresql' || kind === 'sqlite' || kind === 'duckdb') && /\bJSONB?\b/i.test(dataType);
}

export function schemaValueSearchSql(kind: string | undefined, value: string, targets: SchemaValueSearchTarget[]): string {
    if (!supportsSchemaValueSearch(kind)) throw new Error('Value search is supported for Netezza, PostgreSQL, Db2, SQLite, and DuckDB.');
    if (!value.trim()) throw new Error('Enter text or a number to search for.');
    if (value.length > 8000) throw new Error('Search text must be 8,000 characters or fewer.');
    const searchable = targets.filter(target => NUMERIC_COLUMN_TYPE.test(target.dataType) || isSchemaTextType(kind, target.dataType));
    if (!searchable.length) throw new Error('No text or numeric columns were found in the selected tables.');
    const numericValue = value.trim();
    const isNumeric = NUMERIC_LITERAL.test(numericValue);
    const textCastType = schemaSearchCastType(kind);
    const textTargets = searchable.filter(target => isSchemaTextType(kind, target.dataType));
    const escapedPattern = `%${value.replace(/[!%_]/g, character => `!${character}`)}%`;
    const withClause = textTargets.length
        ? `WITH search_input(search_text) AS (VALUES (LOWER(CAST(${sqlStringLiteral(escapedPattern, kind)} AS ${textCastType}))))\n`
        : '';
    const selects = searchable.map(target => {
        const numericColumn = NUMERIC_COLUMN_TYPE.test(target.dataType);
        const predicate = numericColumn && isNumeric
            ? `${target.quotedColumnName} = ${numericValue}`
            : isSchemaTextType(kind, target.dataType)
                ? `LOWER(CAST(${target.quotedColumnName} AS ${textCastType})) LIKE search_input.search_text ESCAPE '!'`
                : undefined;
        if (!predicate) return undefined;
        const from = isSchemaTextType(kind, target.dataType)
            ? `${target.qualifiedTableName}\nCROSS JOIN search_input`
            : target.qualifiedTableName;
        return `SELECT ${sqlStringLiteral(target.location, kind)} AS match_location, SUBSTR(CAST(${target.quotedColumnName} AS ${textCastType}), 1, 16000) AS match_value\nFROM ${from}\nWHERE ${predicate}`;
    }).filter((select): select is string => select !== undefined);
    if (!selects.length) throw new Error(isNumeric ? 'No searchable text or numeric columns were found.' : 'No text columns were found for this value.');
    return `-- Each match_value contains at most the first 16,000 characters.\n${withClause}${selects.join('\nUNION ALL\n')};`;
}

function requiredSqlExpression(value: string, label: string): string {
    const expression = value.trim();
    if (!expression || expression.includes(';')) throw new Error(`Enter one ${label} expression without a statement terminator.`);
    return expression;
}

export function alterColumnSql(
    kind: string | undefined,
    qualifiedTableName: string,
    quotedColumnName: string,
    change: AlterColumnChange,
): string {
    if (kind !== 'postgresql' && kind !== 'db2' && kind !== 'duckdb') {
        throw new Error('Column type, nullability, and default changes are available here for PostgreSQL, Db2, and DuckDB.');
    }
    const prefix = `ALTER TABLE ${qualifiedTableName} ALTER COLUMN ${quotedColumnName} `;
    if (change.operation === 'setType') {
        const dataType = change.dataType.trim();
        if (!isSafeSqlDataType(dataType)) throw new Error('Enter a SQL type made of type names and optional numeric parameters.');
        const using = change.using?.trim() ? ` USING ${requiredSqlExpression(change.using, 'conversion')}` : '';
        if (kind === 'db2' && using) throw new Error('Db2 converts compatible column types directly and does not use a PostgreSQL USING clause.');
        return `${prefix}${kind === 'db2' || kind === 'duckdb' ? 'SET DATA TYPE' : 'TYPE'} ${dataType}${using};`;
    }
    if (change.operation === 'setNotNull') return `${prefix}SET NOT NULL;`;
    if (change.operation === 'dropNotNull') return `${prefix}DROP NOT NULL;`;
    if (change.operation === 'setDefault') return `${prefix}SET DEFAULT ${requiredSqlExpression(change.expression, 'default')};`;
    return `${prefix}DROP DEFAULT;`;
}

export function createIndexSql(
    kind: string | undefined,
    qualifiedIndexName: string,
    qualifiedTableName: string,
    quotedColumns: string,
    options: IndexDesignOptions = {},
): string {
    const columns = quotedColumns.trim();
    if (!columns) throw new Error('Choose at least one index key column.');
    const include = options.includeColumns?.trim();
    const unique = options.unique ? 'UNIQUE ' : '';
    if (kind === 'postgresql') {
        const method = (options.method ?? 'btree').toLowerCase();
        if (!['btree', 'hash', 'gist', 'spgist', 'gin', 'brin'].includes(method)) {
            throw new Error('Choose a supported PostgreSQL index method.');
        }
        if (options.unique && method !== 'btree') {
            throw new Error('PostgreSQL unique indexes currently require the btree method.');
        }
        if (include && !['btree', 'gist', 'spgist'].includes(method)) {
            throw new Error(`PostgreSQL ${method} indexes do not support INCLUDE columns.`);
        }
        const concurrently = options.concurrently ? ' CONCURRENTLY' : '';
        const included = include ? ` INCLUDE (${include})` : '';
        const predicate = options.predicate?.trim() ? ` WHERE ${options.predicate.trim().replace(/;\s*$/, '')}` : '';
        return `CREATE ${unique}INDEX${concurrently} ${qualifiedIndexName} ON ${qualifiedTableName} USING ${method} (${columns})${included}${predicate};`;
    }
    if (kind === 'db2') {
        if (options.pctFree != null && (!Number.isInteger(options.pctFree) || options.pctFree < 0 || options.pctFree > 99)) {
            throw new Error('Db2 PCTFREE must be a whole number from 0 to 99.');
        }
        const included = include ? ` INCLUDE (${include})` : '';
        const clustered = options.clustered ? ' CLUSTER' : '';
        const compress = options.compress ? ' COMPRESS YES' : '';
        const pctFree = options.pctFree == null ? '' : ` PCTFREE ${options.pctFree}`;
        return `CREATE ${unique}INDEX ${qualifiedIndexName} ON ${qualifiedTableName} (${columns})${included}${clustered}${compress}${pctFree};`;
    }
    return `CREATE ${unique}INDEX ${qualifiedIndexName} ON ${qualifiedTableName} (${columns});`;
}

export function createTableFromSql(
    kind: string | undefined,
    target: string,
    source: string,
    whereClause = '',
): string {
    const predicate = whereClause.trim().replace(/;\s*$/, '');
    const select = `SELECT * FROM ${source}${predicate ? ` WHERE ${predicate}` : ''}`;
    if (kind === 'netezza') return `CREATE TABLE ${target} AS (${select}) DISTRIBUTE ON RANDOM;`;
    if (kind === 'db2') return `CREATE TABLE ${target} AS (${select}) WITH DATA;`;
    return `CREATE TABLE ${target} AS ${select};`;
}

export function callRoutineSql(
    kind: string | undefined,
    objectType: 'FUNCTION' | 'PROCEDURE',
    qualifiedName: string,
    argumentsSql = '',
): string {
    const args = argumentsSql.trim();
    if (objectType === 'PROCEDURE') {
        if (kind === 'oracle') return `BEGIN\n  ${qualifiedName}(${args});\nEND;\n/`;
        if (kind === 'sqlite') throw new Error('SQLite does not support stored procedures.');
        return `CALL ${qualifiedName}(${args});`;
    }
    const invocation = `${qualifiedName}(${args})`;
    if (kind === 'db2') return `VALUES ${invocation};`;
    if (kind === 'oracle') return `SELECT ${invocation} AS result FROM DUAL;`;
    return `SELECT ${invocation};`;
}

export function quoteIdentifierForKind(identifier: string, kind?: string | DatabaseKind): string {
    return formatIdentifierForSql(identifier, kind);
}

export function quoteIdentifierListForKind(identifiers: string, kind?: string | DatabaseKind): string {
    return identifiers
        .split(',')
        .map(part => part.trim())
        .filter(part => part.length > 0)
        .map(part => formatIdentifierForSql(part, kind))
        .join(', ');
}

/** Schema-tree object coordinates as the tree reports them (unquoted). */
export interface MenuObjectRef {
    database?: string;
    schema?: string;
    name: string;
}

function qualifiedMenuName(kind: string | undefined, ref: MenuObjectRef): string {
    return formatQualifiedObjectName(ref.database, ref.schema, ref.name, kind);
}

function plainSqlLiteral(value: string, kind: string | undefined): string {
    // MySQL treats backslash as an escape character unless NO_BACKSLASH_ESCAPES is set.
    const escaped = kind === 'mysql' ? value.replace(/\\/g, '\\\\') : value;
    return `'${escaped.replace(/'/g, "''")}'`;
}

function unicodeSqlLiteral(value: string): string {
    return `N'${value.replace(/'/g, "''")}'`;
}

/**
 * SQL Server object DDL (GRANT, ALTER AUTHORIZATION, extended properties) only
 * resolves securables in the current database, so the statement runs through
 * the target database's sp_executesql instead of a three-part name.
 */
function mssqlInDatabase(database: string | undefined, statement: string): string {
    if (!database) return `${statement};`;
    return `EXEC ${formatIdentifierForSql(database, 'mssql')}.sys.sp_executesql ${unicodeSqlLiteral(statement)};`;
}

function mssqlTwoPartName(ref: MenuObjectRef): string {
    const name = formatIdentifierForSql(ref.name, 'mssql');
    return ref.schema ? `${formatIdentifierForSql(ref.schema, 'mssql')}.${name}` : name;
}

function requireMenuIdentifier(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Enter a ${label}.`);
    if (/[;\r\n]/.test(trimmed)) throw new Error(`The ${label} cannot contain semicolons or line breaks.`);
    return trimmed;
}

/**
 * A plain name the user typed stays unquoted so the database applies its own
 * case folding (OWNER_1 and owner_1 mean the same user); anything else is quoted.
 */
function typedIdentifier(value: string, label: string, kind: string | undefined): string {
    const trimmed = requireMenuIdentifier(value, label);
    return /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(trimmed) ? trimmed : formatIdentifierForSql(trimmed, kind);
}

/** Qualifies an already formatted object name with the container of `ref`. */
function siblingName(kind: string | undefined, ref: MenuObjectRef, formattedName: string): string {
    const qualified = qualifiedMenuName(kind, ref);
    const container = qualified.slice(0, qualified.length - formatIdentifierForSql(ref.name, kind).length);
    return `${container}${formattedName}`;
}

export function truncateTableSql(kind: string | undefined, ref: MenuObjectRef): string {
    const name = qualifiedMenuName(kind, ref);
    if (kind === 'sqlite' || kind === 'access') return `DELETE FROM ${name};`;
    // Db2 has no bare TRUNCATE TABLE; the IMMEDIATE variant commits at once.
    if (kind === 'db2') return `TRUNCATE TABLE ${name} IMMEDIATE;`;
    return `TRUNCATE TABLE ${name};`;
}

export function renameTableSql(kind: string | undefined, ref: MenuObjectRef, newName: string): string {
    const target = requireMenuIdentifier(newName, 'new table name');
    const name = qualifiedMenuName(kind, ref);
    switch (kind) {
        case 'mssql': {
            // sp_rename takes the new name as a literal; brackets would become part of the name.
            const procedure = ref.database ? `${formatIdentifierForSql(ref.database, 'mssql')}.sys.sp_rename` : 'sys.sp_rename';
            return `EXEC ${procedure} ${unicodeSqlLiteral(mssqlTwoPartName(ref))}, ${unicodeSqlLiteral(target)};`;
        }
        case 'mysql':
            // An unqualified RENAME TABLE target lands in the session's default database.
            return `RENAME TABLE ${name} TO ${siblingName(kind, ref, typedIdentifier(target, 'new table name', kind))};`;
        case 'snowflake':
            // An unqualified Snowflake rename target moves the table to the session schema.
            return `ALTER TABLE ${name} RENAME TO ${siblingName(kind, ref, typedIdentifier(target, 'new table name', kind))};`;
        case 'db2':
            // Db2 rejects ALTER TABLE ... RENAME TO (SQLCODE -104) and a qualified target (SQLCODE -108).
            return `RENAME TABLE ${name} TO ${typedIdentifier(target, 'new table name', kind)};`;
        case 'access':
        case 'clickhouse':
            throw new Error('Renaming tables is not supported for this database type.');
        default:
            return `ALTER TABLE ${name} RENAME TO ${typedIdentifier(target, 'new table name', kind)};`;
    }
}

export function changeTableOwnerSql(kind: string | undefined, ref: MenuObjectRef, owner: string): string {
    const newOwner = typedIdentifier(owner, 'owner name', kind);
    switch (kind) {
        case undefined:
        case 'netezza':
        case 'postgresql':
        case 'vertica':
            return `ALTER TABLE ${qualifiedMenuName(kind, ref)} OWNER TO ${newOwner};`;
        case 'mssql':
            return mssqlInDatabase(ref.database, `ALTER AUTHORIZATION ON OBJECT::${mssqlTwoPartName(ref)} TO ${newOwner}`);
        case 'snowflake':
            return `GRANT OWNERSHIP ON TABLE ${qualifiedMenuName(kind, ref)} TO ROLE ${newOwner} COPY CURRENT GRANTS;`;
        default:
            throw new Error('Changing the table owner is not supported for this database type.');
    }
}

export interface GrantPrivilegeOption {
    label: string;
    description: string;
}

const BASE_GRANT_PRIVILEGES: readonly GrantPrivilegeOption[] = [
    { label: 'SELECT', description: 'Read data' },
    { label: 'INSERT', description: 'Insert rows' },
    { label: 'UPDATE', description: 'Update rows' },
    { label: 'DELETE', description: 'Delete rows' },
];

const EXTRA_GRANT_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
    netezza: ['LIST', 'TRUNCATE', 'ALTER', 'DROP', 'GENSTATS', 'GROOM'],
    postgresql: ['TRUNCATE', 'REFERENCES', 'TRIGGER'],
    db2: ['ALTER', 'INDEX', 'REFERENCES', 'CONTROL'],
    oracle: ['ALTER', 'INDEX', 'REFERENCES'],
    mssql: ['REFERENCES', 'ALTER', 'CONTROL'],
    mysql: ['ALTER', 'INDEX', 'DROP', 'REFERENCES', 'TRIGGER'],
    snowflake: ['TRUNCATE', 'REFERENCES'],
    vertica: ['TRUNCATE', 'REFERENCES'],
};

export function grantPrivilegeOptions(kind: string | undefined): GrantPrivilegeOption[] {
    const extras = (EXTRA_GRANT_PRIVILEGES[kind ?? ''] ?? []).map(label => ({ label, description: `${label} privilege` }));
    const all = kind === 'mssql'
        ? { label: 'ALL', description: 'SELECT, INSERT, UPDATE and DELETE' }
        : { label: 'ALL', description: 'All object privileges' };
    return [...BASE_GRANT_PRIVILEGES, ...extras, all];
}

/** Returns a validation message for a grantee, or null when it is acceptable. */
export function grantGranteeError(kind: string | undefined, grantee: string): string | null {
    const value = grantee.trim();
    if (!value) return 'User, group or role name cannot be empty';
    if (kind === 'mysql') {
        return parseMysqlAccount(value) ? null : "Use user, user@host or 'user'@'host'";
    }
    return /^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(value) ? null : 'Invalid user, group or role name';
}

function parseMysqlAccount(value: string): { user: string; host: string } | undefined {
    const match = /^(?:'([^']+)'|`([^`]+)`|([\w.$-]+))(?:@(?:'([^']+)'|`([^`]+)`|([\w.%:-]+)))?$/u.exec(value);
    if (!match) return undefined;
    return { user: match[1] ?? match[2] ?? match[3], host: match[4] ?? match[5] ?? match[6] ?? '%' };
}

export function grantSql(
    kind: string | undefined,
    ref: MenuObjectRef,
    objectType: string,
    privilege: string,
    grantee: string,
): string {
    const allowed = grantPrivilegeOptions(kind).map(option => option.label);
    if (!allowed.includes(privilege)) throw new Error(`Privilege ${privilege} is not available for this database type.`);
    const error = grantGranteeError(kind, grantee);
    if (error) throw new Error(error);
    const value = grantee.trim();
    const name = qualifiedMenuName(kind, ref);
    switch (kind) {
        case 'mysql': {
            const account = parseMysqlAccount(value)!;
            const privileges = privilege === 'ALL' ? 'ALL PRIVILEGES' : privilege;
            return `GRANT ${privileges} ON ${name} TO ${plainSqlLiteral(account.user, kind)}@${plainSqlLiteral(account.host, kind)};`;
        }
        case 'mssql': {
            const privileges = privilege === 'ALL' ? 'SELECT, INSERT, UPDATE, DELETE' : privilege;
            return mssqlInDatabase(ref.database, `GRANT ${privileges} ON OBJECT::${mssqlTwoPartName(ref)} TO ${typedIdentifier(value, 'grantee', kind)}`);
        }
        case 'snowflake': {
            const securable = objectType.toUpperCase() === 'VIEW' ? 'VIEW' : 'TABLE';
            return `GRANT ${privilege === 'ALL' ? 'ALL PRIVILEGES' : privilege} ON ${securable} ${name} TO ROLE ${typedIdentifier(value, 'role name', kind)};`;
        }
        case 'access':
        case 'clickhouse':
        case 'sqlite':
        case 'duckdb':
        case 'file':
            throw new Error('Granting privileges is not supported for this database type.');
        default:
            // Unquoted grantees keep the database's own case folding (upper for Netezza/Db2/Oracle, lower for PostgreSQL).
            return `GRANT ${privilege} ON ${name} TO ${value};`;
    }
}

function mssqlDescriptionSql(ref: MenuObjectRef, comment: string, column?: string): string {
    const schema = ref.schema ?? 'dbo';
    const objectId = `OBJECT_ID(${unicodeSqlLiteral(mssqlTwoPartName({ ...ref, schema }))})`;
    const minorId = column ? `COLUMNPROPERTY(${objectId}, ${unicodeSqlLiteral(column)}, 'ColumnId')` : '0';
    const levels = `@level0type = N'SCHEMA', @level0name = ${unicodeSqlLiteral(schema)}, @level1type = N'TABLE', @level1name = ${unicodeSqlLiteral(ref.name)}`
        + (column ? `, @level2type = N'COLUMN', @level2name = ${unicodeSqlLiteral(column)}` : '');
    const property = `@name = N'MS_Description', @value = ${unicodeSqlLiteral(comment)}, ${levels}`;
    const statement = `IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE class = 1 AND major_id = ${objectId} AND minor_id = ${minorId} AND name = N'MS_Description')`
        + ` EXEC sys.sp_updateextendedproperty ${property}`
        + ` ELSE EXEC sys.sp_addextendedproperty ${property}`;
    return mssqlInDatabase(ref.database, statement);
}

export function tableCommentSql(kind: string | undefined, ref: MenuObjectRef, comment: string): string {
    switch (kind) {
        case 'mssql':
            return mssqlDescriptionSql(ref, comment);
        case 'mysql':
            return `ALTER TABLE ${qualifiedMenuName(kind, ref)} COMMENT = ${plainSqlLiteral(comment, kind)};`;
        case 'access':
        case 'clickhouse':
        case 'sqlite':
            throw new Error('Table comments are not supported for this database type.');
        default:
            return `COMMENT ON TABLE ${qualifiedMenuName(kind, ref)} IS ${plainSqlLiteral(comment, kind)};`;
    }
}

export function columnCommentSql(kind: string | undefined, ref: MenuObjectRef, column: string, comment: string): string {
    switch (kind) {
        case 'mssql':
            return mssqlDescriptionSql(ref, comment, column);
        case 'mysql':
        case 'vertica':
        case 'access':
        case 'clickhouse':
        case 'sqlite':
            // MySQL needs the full column definition (MODIFY COLUMN) and Vertica only comments projection columns.
            throw new Error('Column comments are not supported for this database type.');
        default:
            return `COMMENT ON COLUMN ${qualifiedMenuName(kind, ref)}.${formatIdentifierForSql(column, kind)} IS ${plainSqlLiteral(comment, kind)};`;
    }
}

/** Additional tree context a DROP needs beyond the object name. */
export interface DropObjectContext {
    /** Owning table for triggers and indexes, when the dialect needs `ON table`. */
    parentTable?: string;
}

const ROUTINE_DROP_TYPES: ReadonlySet<string> = new Set(['PROCEDURE', 'FUNCTION', 'AGGREGATE']);

/**
 * DROP keyword per dialect and tree object type. Types missing here are
 * deliberately not droppable from the tree (server-level objects such as
 * Db2 servers/wrappers or Snowflake warehouses).
 */
const DROP_KEYWORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    // Live-checked on Netezza 11.2: DROP MATERIALIZED VIEW and DROP EXTERNAL TABLE are syntax errors.
    netezza: {
        'TABLE': 'TABLE', 'VIEW': 'VIEW', 'MATERIALIZED VIEW': 'VIEW', 'EXTERNAL TABLE': 'TABLE',
        'SEQUENCE': 'SEQUENCE', 'SYNONYM': 'SYNONYM', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION', 'AGGREGATE': 'AGGREGATE',
    },
    postgresql: {
        'TABLE': 'TABLE', 'VIEW': 'VIEW', 'MATERIALIZED VIEW': 'MATERIALIZED VIEW', 'FOREIGN TABLE': 'FOREIGN TABLE',
        'SEQUENCE': 'SEQUENCE', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION', 'TRIGGER': 'TRIGGER', 'INDEX': 'INDEX',
    },
    db2: {
        'TABLE': 'TABLE', 'VIEW': 'VIEW', 'MQT': 'TABLE', 'MATERIALIZED VIEW': 'TABLE', 'NICKNAME': 'NICKNAME', 'ALIAS': 'ALIAS',
        'SEQUENCE': 'SEQUENCE', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION', 'TRIGGER': 'TRIGGER', 'INDEX': 'INDEX',
    },
    oracle: {
        'TABLE': 'TABLE', 'VIEW': 'VIEW', 'MATERIALIZED VIEW': 'MATERIALIZED VIEW', 'SEQUENCE': 'SEQUENCE', 'SYNONYM': 'SYNONYM',
        'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION', 'PACKAGE': 'PACKAGE', 'PACKAGE BODY': 'PACKAGE BODY',
        'TRIGGER': 'TRIGGER', 'INDEX': 'INDEX',
    },
    mssql: { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION' },
    mysql: { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION', 'TRIGGER': 'TRIGGER', 'EVENT': 'EVENT' },
    snowflake: {
        'TABLE': 'TABLE', 'VIEW': 'VIEW', 'SEQUENCE': 'SEQUENCE', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION',
        'STAGE': 'STAGE', 'STREAM': 'STREAM', 'TASK': 'TASK', 'FILE FORMAT': 'FILE FORMAT', 'DYNAMIC TABLE': 'DYNAMIC TABLE',
    },
    vertica: { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'PROJECTION': 'PROJECTION', 'PROCEDURE': 'PROCEDURE', 'FUNCTION': 'FUNCTION' },
    clickhouse: { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'MATERIALIZED VIEW': 'VIEW' },
    sqlite: { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'TRIGGER': 'TRIGGER', 'INDEX': 'INDEX' },
    duckdb: { 'TABLE': 'TABLE', 'VIEW': 'VIEW', 'INDEX': 'INDEX', 'SEQUENCE': 'SEQUENCE' },
    file: { 'TABLE': 'TABLE', 'VIEW': 'VIEW' },
    access: { 'TABLE': 'TABLE', 'VIEW': 'VIEW' },
};

export function isDroppableObjectType(kind: string | undefined, objectType: string): boolean {
    return Boolean(DROP_KEYWORDS[kind ?? 'netezza']?.[objectType.toUpperCase()]);
}

export function dropObjectSql(
    kind: string | undefined,
    objectType: string,
    ref: MenuObjectRef,
    context: DropObjectContext = {},
): string {
    const type = objectType.toUpperCase();
    const keyword = DROP_KEYWORDS[kind ?? 'netezza']?.[type];
    if (!keyword) throw new Error(`Dropping ${objectType.toLowerCase()} objects is not supported for this database type.`);
    // Routine tree labels may carry the argument signature (NAME(INTEGER, VARCHAR)). Dialects with
    // overloading need it to pick the routine; MSSQL, MySQL and Oracle reject an argument list.
    const stripsSignature = ROUTINE_DROP_TYPES.has(type) && (kind === 'mssql' || kind === 'mysql' || kind === 'oracle');
    const target = stripsSignature ? { ...ref, name: ref.name.replace(/\s*\(.*\)\s*$/s, '') } : ref;
    // Db2 rejects a database qualifier on triggers, indexes and routines (SQL0108N); schema.name works for every type.
    const name = qualifiedMenuName(kind, kind === 'db2' ? { schema: target.schema, name: target.name } : target);
    if (type === 'TRIGGER' && kind === 'postgresql') {
        if (!context.parentTable) throw new Error('The trigger table is unknown; refresh the schema tree and try again.');
        const table = qualifiedMenuName(kind, { database: ref.database, schema: ref.schema, name: context.parentTable });
        return `DROP TRIGGER ${formatIdentifierForSql(ref.name, kind)} ON ${table};`;
    }
    return `DROP ${keyword} ${name};`;
}

/** Reads the owning table from tree descriptions such as `ON orders (enabled)`. */
export function parentTableFromDescription(description: string | undefined): string | undefined {
    const match = /^ON\s+("(?:[^"]|"")+"|[^\s(]+)/i.exec(description?.trim() ?? '');
    if (!match) return undefined;
    const raw = match[1];
    return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}

/** Tree object types whose rows can be read with SELECT * FROM <object>. */
export const SELECTABLE_SCHEMA_OBJECT_TYPES: ReadonlySet<string> = new Set([
    'TABLE',
    'VIEW',
    'MATERIALIZED VIEW',
    'FOREIGN TABLE',
    'EXTERNAL TABLE',
    'MQT',
    'NICKNAME',
    'ALIAS',
    'SYNONYM',
    'DYNAMIC TABLE',
    'PROJECTION',
]);

/**
 * Drops a table constraint listed in the Keys folder. MySQL has dedicated
 * clauses per constraint kind; the other dialects accept DROP CONSTRAINT.
 */
export function dropConstraintSql(
    kind: string | undefined,
    table: MenuObjectRef,
    constraintName: string,
    constraintKind: string,
): string {
    const tableName = qualifiedMenuName(kind, table);
    const name = formatIdentifierForSql(requireMenuIdentifier(constraintName, 'constraint name'), kind);
    if (kind === 'mysql') {
        switch (constraintKind.toUpperCase()) {
            case 'PRIMARY KEY': return `ALTER TABLE ${tableName} DROP PRIMARY KEY;`;
            case 'FOREIGN KEY': return `ALTER TABLE ${tableName} DROP FOREIGN KEY ${name};`;
            case 'UNIQUE': return `ALTER TABLE ${tableName} DROP INDEX ${name};`;
            default: return `ALTER TABLE ${tableName} DROP CHECK ${name};`;
        }
    }
    return `ALTER TABLE ${tableName} DROP CONSTRAINT ${name};`;
}

/** Object types whose stored rows are refreshed from their defining query, per dialect. */
const REFRESHABLE_OBJECT_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
    netezza: new Set(['MATERIALIZED VIEW']),
    postgresql: new Set(['MATERIALIZED VIEW']),
    oracle: new Set(['MATERIALIZED VIEW']),
    db2: new Set(['MATERIALIZED QUERY TABLE']),
};

export function isRefreshableObjectType(kind: string | undefined, objectType: string): boolean {
    return Boolean(REFRESHABLE_OBJECT_TYPES[kind ?? 'netezza']?.has(objectType.toUpperCase()));
}

/**
 * Refreshes a materialized view (Db2: a REFRESH DEFERRED MQT). `concurrently`
 * keeps a PostgreSQL view readable during the refresh; it needs a unique index.
 */
export function refreshMaterializedViewSql(
    kind: string | undefined,
    objectType: string,
    ref: MenuObjectRef,
    options: { concurrently?: boolean } = {},
): string {
    if (!isRefreshableObjectType(kind, objectType)) {
        throw new Error(`Refreshing ${objectType.toLowerCase()} objects is not supported for this database type.`);
    }
    switch (kind ?? 'netezza') {
        case 'postgresql':
            return `REFRESH MATERIALIZED VIEW ${options.concurrently ? 'CONCURRENTLY ' : ''}${qualifiedMenuName(kind, ref)};`;
        case 'oracle':
            // DBMS_MVIEW takes the name as text; the quoted form keeps mixed-case names exact.
            return `BEGIN DBMS_MVIEW.REFRESH(${plainSqlLiteral(qualifiedMenuName(kind, { schema: ref.schema, name: ref.name }), kind)}); END;`;
        case 'db2':
            return `REFRESH TABLE ${qualifiedMenuName(kind, { schema: ref.schema, name: ref.name })};`;
        default:
            return `ALTER VIEW ${qualifiedMenuName(kind, ref)} MATERIALIZE REFRESH;`;
    }
}
