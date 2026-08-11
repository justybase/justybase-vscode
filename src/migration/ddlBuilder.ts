/**
 * CREATE TABLE DDL generation for migration targets.
 */

import type { DatabaseKind } from '../contracts/database';
import { getDatabaseDialectTraits } from '../core/dialectTraits';
import { formatIdentifierForSql, formatQualifiedObjectName, quoteIdentifier } from '../utils/identifierUtils';

export interface DdlColumnSpec {
    name: string;
    /** Rendered target dialect type, e.g. `NVARCHAR(255)`. */
    type: string;
    notNull: boolean;
    isPk: boolean;
    /** Simple literal default value (already dialect-safe) or undefined. */
    defaultValue?: string;
}

export interface BuildCreateTableOptions {
    /** Distribution key columns (Netezza); default RANDOM when a PK exists. */
    distributionColumns?: string[];
}

const SIMPLE_DEFAULT_PATTERN = /^(?:'([^']|'')*'|-?\d+(?:\.\d+)?|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|CURRENT_USER|NULL|TRUE|FALSE|1|0)$/i;

/**
 * Returns a dialect-safe default clause when the source default is a simple
 * literal or ANSI keyword; otherwise returns undefined.
 */
export function sanitizeDefaultValue(value: string | null | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || !SIMPLE_DEFAULT_PATTERN.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}

export interface ResolvedTargetParts {
    database?: string;
    schema?: string;
}

/**
 * Reduces the (database, schema) pair to the parts the target dialect can
 * actually reference. Only Netezza keeps the database qualifier (three-part
 * names and `DB..TABLE`); every other target runs against the connection's
 * active database, so the schema is the only container part passed through.
 */
export function resolveTargetQualificationParts(
    kind: DatabaseKind,
    database: string | undefined,
    schema: string | undefined,
): ResolvedTargetParts {
    if (kind === 'netezza') {
        return { database, schema };
    }
    return { database: undefined, schema };
}

/**
 * Normalizes an identifier to the target dialect's generated-name case.
 */
export function normalizeTargetIdentifierCase(name: string, kind: DatabaseKind): string {
    const generatedCase = getDatabaseDialectTraits(kind).identifiers.generatedNameCase;
    if (generatedCase === 'lower') {
        return name.toLowerCase();
    }
    if (generatedCase === 'upper') {
        return name.toUpperCase();
    }
    return name;
}

/**
 * Builds a fully qualified target name respecting dialect qualification traits.
 */
export function buildTargetQualifiedName(
    database: string | undefined,
    schema: string | undefined,
    table: string,
    kind: DatabaseKind,
): string {
    const parts = resolveTargetQualificationParts(kind, database, schema);
    return formatQualifiedObjectName(parts.database, parts.schema, table, kind);
}

/**
 * Builds `CREATE TABLE` DDL for the target dialect.
 */
export function buildCreateTableDdl(
    kind: DatabaseKind,
    qualifiedName: string,
    columns: readonly DdlColumnSpec[],
    options?: BuildCreateTableOptions,
): string {
    const formatColumnName = (name: string): string => kind === 'netezza'
        ? quoteIdentifier(name)
        : formatIdentifierForSql(name, kind);
    const lines = columns.map(column => {
        let definition = `    ${formatColumnName(column.name)} ${column.type}`;
        if (column.defaultValue) {
            definition += ` DEFAULT ${column.defaultValue}`;
        }
        if (column.notNull) {
            definition += ' NOT NULL';
        }
        return definition;
    });

    const pkColumns = columns.filter(column => column.isPk);
    const pkList = pkColumns.map(column => formatColumnName(column.name));

    let ddl = `CREATE TABLE ${qualifiedName} (\n${lines.join(',\n')}`;
    if (pkList.length > 0 && kind !== 'access' && kind !== 'netezza') {
        ddl += `,\n    PRIMARY KEY (${pkList.join(', ')})`;
    }
    ddl += '\n)';

    if (kind === 'netezza') {
        const distributionColumns = options?.distributionColumns?.length
            ? options.distributionColumns
            : [];
        ddl += distributionColumns.length > 0
            ? `\nDISTRIBUTE ON (${distributionColumns.join(', ')})`
            : '\nDISTRIBUTE ON RANDOM';
    }

    return ddl;
}
