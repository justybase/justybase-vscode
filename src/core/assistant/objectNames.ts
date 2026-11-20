import { escapeSqlIdentifier } from '../../utils/sqlUtils';

/**
 * Parsing and rendering of Netezza qualified object names.
 *
 * Netezza treats `DATABASE..TABLE` as a first-class notation (database plus the
 * default schema), so the empty middle segment must survive parsing. The same
 * parser is used by destructive tools, the catalog tool and procedure CALL
 * generation so every surface targets the same object.
 */

export interface ObjectNameInput {
    readonly object: string;
    readonly database?: string;
    readonly schema?: string;
}

interface ParsedObjectName {
    readonly database?: string;
    readonly schema?: string;
    readonly table: string;
}

const IDENTIFIER = /^(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)$/u;

function splitQualifiedName(value: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < value.length; index += 1) {
        const char = value[index]!;
        if (char === '"') {
            if (inQuotes && value[index + 1] === '"') {
                current += '""';
                index += 1;
            } else {
                inQuotes = !inQuotes;
                current += char;
            }
            continue;
        }
        if (char === '.' && !inQuotes) {
            parts.push(current);
            current = '';
            continue;
        }
        current += char;
    }

    parts.push(current);
    return parts;
}

function normalizePart(part: string): string {
    const trimmed = part.trim();
    if (!trimmed) {
        return '';
    }
    if (!IDENTIFIER.test(trimmed)) {
        throw new Error(
            'Object names must use simple Netezza identifiers or double-quoted identifiers.'
        );
    }
    return trimmed;
}

function parseObjectName(value: string): ParsedObjectName {
    if (!value.trim()) {
        throw new Error('Object name cannot be empty.');
    }

    const parts = splitQualifiedName(value).map(normalizePart);
    if (parts.length === 1) {
        if (!parts[0]) throw new Error('Object name cannot be empty.');
        return { table: parts[0] };
    }
    if (parts.length === 2) {
        if (!parts[0] || !parts[1]) {
            throw new Error('Object names must use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
        }
        return { schema: parts[0], table: parts[1] };
    }
    if (parts.length === 3) {
        if (!parts[0] || !parts[2]) {
            throw new Error('Object names must use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
        }
        if (parts[1] === '') {
            return { database: parts[0], table: parts[2] };
        }
        return { database: parts[0], schema: parts[1], table: parts[2] };
    }

    throw new Error('Object names must use TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE.');
}

function resolveObjectName(input: ObjectNameInput): Required<Pick<ParsedObjectName, 'table'>> & {
    database?: string;
    schema?: string;
} {
    const parsed = parseObjectName(input.object);
    const database = input.database?.trim();
    const schema = input.schema?.trim();

    if (database && parsed.database && database.toUpperCase() !== parsed.database.toUpperCase()) {
        throw new Error(
            `Conflicting database names: the object uses "${parsed.database}" but database "${database}" was requested.`
        );
    }
    if (schema && parsed.schema && schema.toUpperCase() !== parsed.schema.toUpperCase()) {
        throw new Error(
            `Conflicting schema names: the object uses "${parsed.schema}" but schema "${schema}" was requested.`
        );
    }

    return {
        database: database ?? parsed.database,
        schema: schema ?? parsed.schema,
        table: parsed.table,
    };
}

function renderParts(input: ObjectNameInput): string[] {
    const resolved = resolveObjectName(input);
    if (resolved.schema) {
        return resolved.database
            ? [resolved.database, resolved.schema, resolved.table]
            : [resolved.schema, resolved.table];
    }
    return resolved.database
        ? [resolved.database, '', resolved.table]
        : [resolved.table];
}

/** Dotted name for catalog lookups. `DATABASE..TABLE` keeps its empty segment. */
export function normalizeObjectName(input: ObjectNameInput): string {
    return renderParts(input).join('.');
}

/** SQL identifier for DROP/CALL statements. Every non-empty segment is quoted. */
export function sqlObjectName(input: ObjectNameInput): string {
    return renderParts(input)
        .map(part => (part.length > 0 ? escapeSqlIdentifier(unquoteIdentifier(part)) : ''))
        .join('.');
}

function unquoteIdentifier(value: string): string {
    return value.replace(/^"|"$/gu, '').replace(/""/gu, '"');
}

/** Short (unqualified, unquoted) name of the last object segment. */
export function shortObjectName(value: string): string | undefined {
    const parts = splitQualifiedName(value)
        .map(part => part.trim())
        .filter(part => part.length > 0);
    const last = parts[parts.length - 1];
    return last ? unquoteIdentifier(last) : undefined;
}
