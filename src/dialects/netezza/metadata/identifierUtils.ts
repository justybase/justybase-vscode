/**
 * Netezza identifier semantics used by metadata queries and completion.
 *
 * A plain identifier is folded to upper case by Netezza.  A quoted
 * identifier, and a value read from a system catalog, is case-sensitive and
 * must be kept byte-for-byte (including meaningful spaces).
 */

import { NETEZZA_UNQUOTED_IDENTIFIER_PATTERN } from '../identifierPattern';

export type NetezzaIdentifierSource = 'user' | 'catalog';

export interface NetezzaIdentifier {
    value: string;
    source: NetezzaIdentifierSource;
    quoted: boolean;
}

export function isNetezzaQuotedIdentifier(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

/** Remove SQL identifier quotes without trimming the identifier contents. */
export function unquoteNetezzaIdentifier(value: string): string {
    const trimmed = value.trim();
    if (!isNetezzaQuotedIdentifier(trimmed)) {
        return trimmed;
    }
    return trimmed.slice(1, -1).replace(/""/g, '"');
}

export function createNetezzaUserIdentifier(
    value: string,
    quoted = isNetezzaQuotedIdentifier(value),
): NetezzaIdentifier {
    const exactValue = unquoteNetezzaIdentifier(value);
    return {
        value: quoted ? exactValue : exactValue.toUpperCase(),
        source: 'user',
        quoted,
    };
}

export function createNetezzaCatalogIdentifier(value: string): NetezzaIdentifier {
    return {
        value: String(value ?? ''),
        source: 'catalog',
        quoted: false,
    };
}

export function createNetezzaIdentifier(
    value: string | NetezzaIdentifier,
    defaultSource: NetezzaIdentifierSource = 'user',
): NetezzaIdentifier {
    if (typeof value !== 'string') {
        return value;
    }
    return defaultSource === 'catalog'
        ? createNetezzaCatalogIdentifier(value)
        : createNetezzaUserIdentifier(value);
}

export function escapeNetezzaSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
}

/**
 * Format an identifier for SQL without changing catalog values.  Catalog
 * values that cannot be represented as an unquoted Netezza identifier are
 * quoted exactly, including trailing spaces.
 */
export function formatNetezzaIdentifier(identifier: NetezzaIdentifier): string {
    const needsQuotes = identifier.quoted || !NETEZZA_UNQUOTED_IDENTIFIER_PATTERN.test(identifier.value);
    if (!needsQuotes) {
        return identifier.value;
    }
    return `"${identifier.value.replace(/"/g, '""')}"`;
}

export function buildNetezzaIdentifierEquality(
    columnExpression: string,
    identifier: string | NetezzaIdentifier,
    defaultSource: NetezzaIdentifierSource = 'user',
): string {
    const resolved = createNetezzaIdentifier(identifier, defaultSource);
    return `${columnExpression} = '${escapeNetezzaSqlLiteral(resolved.value)}'`;
}
