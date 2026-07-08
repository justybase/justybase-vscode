/**
 * Identifier utilities shared across SQL dialects.
 */

import { type DatabaseKind, normalizeDatabaseKind } from '../contracts/database';
import { getDatabaseDialectTraits } from '../core/dialectTraits';
const SQLITE_RESERVED_KEYWORDS = new Set([
    'ABORT',
    'ACTION',
    'ADD',
    'AFTER',
    'ALL',
    'ALTER',
    'ALWAYS',
    'ANALYZE',
    'AND',
    'AS',
    'ASC',
    'ATTACH',
    'AUTOINCREMENT',
    'BEFORE',
    'BEGIN',
    'BETWEEN',
    'BY',
    'CASCADE',
    'CASE',
    'CAST',
    'CHECK',
    'COLLATE',
    'COLUMN',
    'COMMIT',
    'CONFLICT',
    'CONSTRAINT',
    'CREATE',
    'CROSS',
    'CURRENT',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'CURRENT_TIMESTAMP',
    'DATABASE',
    'DEFAULT',
    'DEFERRABLE',
    'DEFERRED',
    'DELETE',
    'DESC',
    'DETACH',
    'DISTINCT',
    'DO',
    'DROP',
    'EACH',
    'ELSE',
    'END',
    'ESCAPE',
    'EXCEPT',
    'EXCLUDE',
    'EXCLUSIVE',
    'EXISTS',
    'EXPLAIN',
    'FAIL',
    'FILTER',
    'FIRST',
    'FOLLOWING',
    'FOR',
    'FOREIGN',
    'FROM',
    'FULL',
    'GENERATED',
    'GLOB',
    'GROUP',
    'GROUPS',
    'HAVING',
    'IF',
    'IGNORE',
    'IMMEDIATE',
    'IN',
    'INDEX',
    'INDEXED',
    'INITIALLY',
    'INNER',
    'INSERT',
    'INSTEAD',
    'INTERSECT',
    'INTO',
    'IS',
    'ISNULL',
    'JOIN',
    'KEY',
    'LAST',
    'LEFT',
    'LIKE',
    'LIMIT',
    'MATCH',
    'MATERIALIZED',
    'NATURAL',
    'NO',
    'NOT',
    'NOTHING',
    'NOTNULL',
    'NULL',
    'NULLS',
    'OF',
    'OFFSET',
    'ON',
    'OR',
    'ORDER',
    'OTHERS',
    'OUTER',
    'OVER',
    'PARTITION',
    'PLAN',
    'PRAGMA',
    'PRECEDING',
    'PRIMARY',
    'QUERY',
    'RAISE',
    'RANGE',
    'RECURSIVE',
    'REFERENCES',
    'REGEXP',
    'REINDEX',
    'RELEASE',
    'RENAME',
    'REPLACE',
    'RESTRICT',
    'RETURNING',
    'RIGHT',
    'ROLLBACK',
    'ROW',
    'ROWS',
    'SAVEPOINT',
    'SELECT',
    'SET',
    'TABLE',
    'TEMP',
    'TEMPORARY',
    'THEN',
    'TIES',
    'TO',
    'TRANSACTION',
    'TRIGGER',
    'UNBOUNDED',
    'UNION',
    'UNIQUE',
    'UPDATE',
    'USING',
    'VACUUM',
    'VALUES',
    'VIEW',
    'VIRTUAL',
    'WHEN',
    'WHERE',
    'WINDOW',
    'WITH',
    'WITHOUT'
]);
export const SQLITE_RESERVED_KEYWORD_LIST = Array.from(SQLITE_RESERVED_KEYWORDS.values()).sort();

function splitIdentifierSignature(identifier: string): { identifierPart: string; signaturePart: string } {
    const trimmed = identifier.trim();
    const signatureStart = trimmed.indexOf('(');
    if (signatureStart <= 0 || !trimmed.endsWith(')')) {
        return { identifierPart: trimmed, signaturePart: '' };
    }

    const signaturePart = trimmed.slice(signatureStart);
    let depth = 0;
    for (const char of signaturePart) {
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth < 0) {
                return { identifierPart: trimmed, signaturePart: '' };
            }
        }
    }

    if (depth !== 0) {
        return { identifierPart: trimmed, signaturePart: '' };
    }

    return {
        identifierPart: trimmed.slice(0, signatureStart).trimEnd(),
        signaturePart
    };
}

function normalizeIdentifierKind(kind?: string | DatabaseKind): DatabaseKind | undefined {
    return kind ? normalizeDatabaseKind(kind) : undefined;
}

function getIdentifierPattern(kind?: string | DatabaseKind): RegExp {
    return getDatabaseDialectTraits(kind).identifiers.unquotedIdentifierPattern;
}

function usesBacktickIdentifiers(kind?: string | DatabaseKind): boolean {
    return getDatabaseDialectTraits(kind).identifiers.quoteStyle === 'backtick';
}

function usesDatabaseObjectTwoPartName(kind?: string | DatabaseKind): boolean {
    return getDatabaseDialectTraits(kind).qualification.twoPartNameStyle === 'database-object';
}

function prefersSchemaOverDatabase(kind?: string | DatabaseKind): boolean {
    return getDatabaseDialectTraits(kind).qualification.twoPartContainerPreference === 'schema-over-database';
}

function supportsThreePartQualifiedName(kind?: string | DatabaseKind): boolean {
    return getDatabaseDialectTraits(kind).qualification.supportsThreePartName;
}

function getDatabaseOnlyReferenceStyle(kind?: string | DatabaseKind): 'double-dot' | 'single-dot' | 'omit' {
    return getDatabaseDialectTraits(kind).qualification.databaseOnlyReferenceStyle;
}

function isReservedKeyword(identifier: string): boolean {
    return SQLITE_RESERVED_KEYWORDS.has(identifier.trim().toUpperCase());
}

function shouldCheckReservedKeywords(kind?: string | DatabaseKind): boolean {
    const normalizedKind = normalizeIdentifierKind(kind);
    return normalizedKind === 'sqlite'
        || normalizedKind === 'duckdb'
        || normalizedKind === 'postgresql'
        || normalizedKind === 'mysql';
}

function normalizeFormattedIdentifier(identifier: string, kind?: string | DatabaseKind): string {
    const trimmed = identifier.trim();

    if (usesBacktickIdentifiers(kind)) {
        if (trimmed.length >= 2 && trimmed.startsWith('`') && trimmed.endsWith('`')) {
            return trimmed.slice(1, -1).replace(/``/g, '`');
        }
        if (isQuotedIdentifier(trimmed)) {
            return unquoteIdentifier(trimmed);
        }
        return trimmed;
    }

    return unquoteIdentifier(trimmed);
}

function quoteIdentifierForKind(identifier: string, kind?: string | DatabaseKind): string {
    if (usesBacktickIdentifiers(kind)) {
        return `\`${identifier.replace(/`/g, '``')}\``;
    }

    return quoteIdentifier(identifier);
}

function formatDatabaseOnlyQualifiedName(databaseName: string, objectName: string, kind?: string | DatabaseKind): string {
    const referenceStyle = getDatabaseOnlyReferenceStyle(kind);
    if (referenceStyle === 'single-dot') {
        return `${databaseName}.${objectName}`;
    }
    if (referenceStyle === 'double-dot') {
        return `${databaseName}..${objectName}`;
    }
    return objectName;
}

/**
 * Returns true when identifier is wrapped in double quotes.
 */
export function isQuotedIdentifier(identifier: string): boolean {
    if (!identifier) {
        return false;
    }
    const trimmed = identifier.trim();
    return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

/**
 * Removes outer double quotes and unescapes doubled quotes.
 */
export function unquoteIdentifier(identifier: string): string {
    if (!identifier) {
        return identifier;
    }
    const trimmed = identifier.trim();
    if (!isQuotedIdentifier(trimmed)) {
        return trimmed;
    }
    return trimmed.slice(1, -1).replace(/""/g, '"');
}

/**
 * Removes one layer of dialect-appropriate identifier quoting.
 */
export function stripIdentifierQuoting(identifier: string, kind?: string | DatabaseKind): string {
    if (!identifier) {
        return identifier;
    }

    const trimmed = identifier.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed.slice(1, -1);
    }

    return normalizeFormattedIdentifier(trimmed, kind);
}

/**
 * Adds double quotes and escapes internal quotes.
 */
export function quoteIdentifier(identifier: string): string {
    const unquoted = unquoteIdentifier(identifier);
    return `"${unquoted.replace(/"/g, '""')}"`;
}

/**
 * Checks whether identifier requires double quoting in SQL.
 */
export function requiresIdentifierQuoting(identifier: string, kind?: string | DatabaseKind): boolean {
    const { identifierPart } = splitIdentifierSignature(identifier);
    const unquoted = normalizeFormattedIdentifier(identifierPart, kind);
    if (!unquoted) {
        return false;
    }
    return !getIdentifierPattern(kind).test(unquoted) || (shouldCheckReservedKeywords(kind) && isReservedKeyword(unquoted));
}

/**
 * Returns identifier in SQL-ready form (quoted only when needed).
 */
export function formatIdentifierForSql(identifier: string, kind?: string | DatabaseKind): string {
    const { identifierPart, signaturePart } = splitIdentifierSignature(identifier);
    const unquoted = normalizeFormattedIdentifier(identifierPart, kind);
    if (!unquoted) {
        return unquoted;
    }
    const formattedIdentifier = requiresIdentifierQuoting(unquoted, kind) ? quoteIdentifierForKind(unquoted, kind) : unquoted;
    return signaturePart ? `${formattedIdentifier}${signaturePart}` : formattedIdentifier;
}

/**
 * Formats a potentially qualified object name using dialect-aware rules.
 */
export function formatQualifiedObjectName(
    databaseName: string | undefined,
    schemaName: string | undefined,
    objectName: string,
    kind?: string | DatabaseKind
): string {
    const normalizedKind = normalizeIdentifierKind(kind);
    const formattedObjectName = formatIdentifierForSql(objectName, normalizedKind);

    if (usesDatabaseObjectTwoPartName(normalizedKind)) {
        const containerName = prefersSchemaOverDatabase(normalizedKind) ? schemaName || databaseName : databaseName || schemaName;
        if (!containerName) {
            return formattedObjectName;
        }
        return `${formatIdentifierForSql(containerName, normalizedKind)}.${formattedObjectName}`;
    }

    if (databaseName && schemaName && supportsThreePartQualifiedName(normalizedKind)) {
        return `${databaseName}.${schemaName}.${formattedObjectName}`;
    }
    if (schemaName) {
        return `${schemaName}.${formattedObjectName}`;
    }
    if (databaseName) {
        return formatDatabaseOnlyQualifiedName(databaseName, formattedObjectName, normalizedKind);
    }

    return formattedObjectName;
}

/**
 * Formats a potentially qualified object path for display purposes.
 */
export function formatQualifiedObjectPathForDisplay(
    databaseName: string | undefined,
    schemaName: string | undefined,
    objectName: string,
    kind?: string | DatabaseKind
): string {
    const normalizedKind = normalizeIdentifierKind(kind);

    if (usesDatabaseObjectTwoPartName(normalizedKind)) {
        const containerName = prefersSchemaOverDatabase(normalizedKind) ? schemaName || databaseName : databaseName || schemaName;
        return containerName ? `${containerName}.${objectName}` : objectName;
    }

    if (databaseName && schemaName && supportsThreePartQualifiedName(normalizedKind)) {
        return `${databaseName}.${schemaName}.${objectName}`;
    }
    if (schemaName) {
        return `${schemaName}.${objectName}`;
    }
    if (databaseName) {
        return formatDatabaseOnlyQualifiedName(databaseName, objectName, normalizedKind);
    }

    return objectName;
}
