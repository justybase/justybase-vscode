import { createRequire } from 'node:module';
import type {
    DuckDBConnection as DuckDbRuntimeConnection,
    DuckDBInstance,
    DuckDBValue,
} from '@duckdb/node-api';
import type {
    AccessColumnDefinition,
    AccessComplexValue,
    AccessIndexDefinition,
    AccessRelationshipDefinition,
    AccessScalarValue,
    AccessTableDefinition,
    AccessTableSnapshot,
    AccessValue,
} from '@justybase/access-file';
import { AccessFileError, AccessFileSession } from '@justybase/access-file';
import { serializeAccessComplexValue } from '@justybase/access-file/complexValues';
import {
    accessMirrorKeyConstraintSql,
    accessMirrorKeyIndexSql,
    planAccessMirrorKeys,
    type AccessMirrorKeyPlan,
} from './accessMirrorKeys';
import {
    accessMirrorReferenceSql,
    orderTablesForMirror,
    planAccessMirrorReferences,
    type AccessMirrorReferencePlan,
} from './accessMirrorReferences';
import { translateAccessFunctions } from './accessSqlFunctions';
import { buildAccessCheckConstraints, buildAccessZeroLengthCheck } from './accessValidationRules';

export interface AccessMirrorColumn {
    readonly name: string;
    readonly type: string;
    readonly scale?: number;
}

export interface AccessMirrorResult {
    readonly columns: readonly AccessMirrorColumn[];
    readonly rows?: readonly (readonly unknown[])[];
    readonly rowChunks?: AsyncIterable<readonly (readonly unknown[])[]>;
    readonly recordsAffected: number;
}

interface DuckDbResultLike {
    readonly columnCount: number;
    columnName(columnIndex: number): string;
    columnType(columnIndex: number): { toString(): string };
    yieldRowsJs(): AsyncIterableIterator<readonly (readonly unknown[])[]>;
}

interface DuckDbConnectionLike {
    stream(sql: string): Promise<DuckDbResultLike>;
    run(sql: string, values?: readonly DuckDBValue[]): Promise<{ readonly rowsChanged: number }>;
}

interface DuckDbModule {
    DuckDBInstance: {
        create(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
    };
    blobValue(input: Uint8Array): DuckDBValue;
    timestampValue(micros: bigint): DuckDBValue;
}

const extensionRequire = createRequire(__filename);
let duckDbModulePromise: Promise<DuckDbModule> | undefined;

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function stripTrailingSemicolons(sql: string): string {
    return sql.trim().replace(/;+$/, '').trim();
}

function translateAccessDateLiterals(sql: string): string {
    return sql.replace(/#([^#]+)#/g, (_match, value: string) => {
        const source = value.trim();
        const usDate = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
        let normalized = source;
        if (usDate) {
            let hour = Number(usDate[4] ?? 0);
            const meridiem = usDate[7]?.toUpperCase();
            if (meridiem === 'AM' && hour === 12) hour = 0;
            if (meridiem === 'PM' && hour < 12) hour += 12;
            const date = `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`;
            normalized = usDate[4] === undefined
                ? date
                : `${date} ${String(hour).padStart(2, '0')}:${usDate[5]}:${usDate[6] ?? '00'}`;
        }
        normalized = normalized.replace(/'/g, "''");
        return `TIMESTAMP '${normalized}'`;
    });
}

function decodeAccessQuotedText(literal: string): string {
    const quote = literal[0];
    const text = literal.slice(1, -1);
    return text.replace(new RegExp(`${quote}${quote}`, 'g'), quote ?? '');
}

/**
 * Converts an Access LIKE pattern to a DuckDB SIMILAR TO pattern.
 * Access supports * (any), ? (one), # (digit) and [abc] / [!abc] classes.
 */
function accessPatternToSimilar(pattern: string): string {
    let out = '';
    for (let index = 0; index < pattern.length; index++) {
        const c = pattern[index]!;
        if (c === '*') {
            out += '.*';
        } else if (c === '?') {
            out += '.';
        } else if (c === '#') {
            out += '[0-9]';
        } else if (c === '%') {
            out += '.*';
        } else if (c === '_') {
            out += '.';
        } else if (c === '[') {
            const close = pattern.indexOf(']', index + 1);
            if (close < 0) {
                out += '\\[';
            } else {
                const cls = pattern.slice(index + 1, close);
                const negated = cls.startsWith('!');
                out += '[' + (negated ? '^' : '') + cls.slice(negated ? 1 : 0) + ']';
                index = close;
            }
        } else if ('\\^$+{}()|'.includes(c)) {
            out += '\\' + c;
        } else {
            out += c;
        }
    }
    return out;
}

function translateAccessLikeExpressions(sql: string): string {
    let result = '';
    let index = 0;
    while (index < sql.length) {
        const current = sql[index];
        const next = sql[index + 1];
        if (current === '-' && next === '-') {
            const end = sql.indexOf('\n', index + 2);
            const stop = end < 0 ? sql.length : end;
            result += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            const stop = end < 0 ? sql.length : end + 2;
            result += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (current === '#') {
            const end = sql.indexOf('#', index + 1);
            const stop = end < 0 ? sql.length : end + 1;
            result += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (current === '\'' || current === '"') {
            const quote = current;
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== quote) {
                    stop++;
                    continue;
                }
                if (sql[stop + 1] === quote) {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            result += sql.slice(index, stop);
            index = stop;
            continue;
        }
        if (current === '[') {
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== ']') {
                    stop++;
                    continue;
                }
                if (sql[stop + 1] === ']') {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            result += sql.slice(index, stop);
            index = stop;
            continue;
        }

        const match = /[A-Za-z0-9_]/.test(sql[index - 1] ?? '')
            ? undefined
            : sql.slice(index).match(
                /^LIKE\s+((?:'(?:(?:'')|[^'])*')|(?:"(?:""|[^"])*"))/i,
            );
        if (!match) {
            result += current ?? '';
            index++;
            continue;
        }
        const literal = match[1]!;
        const pattern = decodeAccessQuotedText(literal);
        if (!/[#*?[]/.test(pattern)) {
            result += `LIKE '${pattern.replace(/'/g, "''")}'`;
        } else {
            // Access text comparisons use the database's default
            // case-insensitive collation. DuckDB's SIMILAR TO does not
            // inherit that collation, so make the expression insensitive.
            result += `SIMILAR TO '(?i)${accessPatternToSimilar(pattern).replace(/'/g, "''")}'`;
        }
        index += match[0].length;
    }
    return result;
}

interface ProtectedSql {
    readonly code: string;
    restore(code: string): string;
}

function protectAccessSqlRegions(sql: string): ProtectedSql {
    const regions: string[] = [];
    let code = '';
    let index = 0;
    const marker = (value: string): string => {
        const regionIndex = regions.push(value) - 1;
        return `\uE000${regionIndex}\uE001`;
    };

    while (index < sql.length) {
        const current = sql[index];
        const next = sql[index + 1];
        if (current === '-' && next === '-') {
            const end = sql.indexOf('\n', index + 2);
            const stop = end < 0 ? sql.length : end;
            code += marker(sql.slice(index, stop));
            index = stop;
            continue;
        }
        if (current === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            const stop = end < 0 ? sql.length : end + 2;
            code += marker(sql.slice(index, stop));
            index = stop;
            continue;
        }
        if (current === '\'' || current === '"') {
            const quote = current;
            let stop = index + 1;
            while (stop < sql.length) {
                if (sql[stop] !== quote) {
                    stop++;
                    continue;
                }
                if (sql[stop + 1] === quote) {
                    stop += 2;
                    continue;
                }
                stop++;
                break;
            }
            const literal = sql.slice(index, stop);
            const value = quote === '"'
                ? `'${decodeAccessQuotedText(literal).replace(/'/g, "''")}'`
                : literal;
            code += marker(value);
            index = stop;
            continue;
        }
        if (current === '[') {
            let stop = index + 1;
            let identifier = '';
            let closed = false;
            while (stop < sql.length) {
                if (sql[stop] === ']' && sql[stop + 1] === ']') {
                    identifier += ']';
                    stop += 2;
                    continue;
                }
                if (sql[stop] === ']') {
                    stop++;
                    closed = true;
                    break;
                }
                identifier += sql[stop] ?? '';
                stop++;
            }
            if (closed) {
                code += marker(quoteIdentifier(identifier));
                index = stop;
                continue;
            }
        }
        code += current ?? '';
        index++;
    }

    return {
        code,
        restore(value: string): string {
            return value.replace(/\uE000(\d+)\uE001/g, (_match, regionIndex: string) => regions[Number(regionIndex)] ?? '');
        },
    };
}

function translateTop(sql: string): string {
    let start = 0;
    while (start < sql.length) {
        while (start < sql.length && /\s/.test(sql[start]!)) start++;
        if (sql.startsWith('--', start)) {
            const newline = sql.indexOf('\n', start + 2);
            start = newline < 0 ? sql.length : newline + 1;
            continue;
        }
        if (sql.startsWith('/*', start)) {
            const end = sql.indexOf('*/', start + 2);
            start = end < 0 ? sql.length : end + 2;
            continue;
        }
        break;
    }
    const match = sql.slice(start).match(/^(SELECT\s+(?:(?:DISTINCT|ALL)\s+)?)(TOP\s+(\d+)(?:\s+PERCENT)?\s+)/i);
    if (!match) {
        return sql;
    }
    if (/\bPERCENT\b/i.test(match[0])) {
        throw new AccessFileError('Access TOP PERCENT queries are not supported by the DuckDB mirror yet.');
    }
    const limit = Number(match[3]);
    if (!Number.isInteger(limit) || limit < 0) {
        return sql;
    }
    const withoutTop = `${sql.slice(0, start)}${match[1]}${sql.slice(start + match[0].length)}`;
    return `${withoutTop} LIMIT ${limit}`;
}

export function translateAccessSql(sql: string): string {
    const withPreamble = rewriteAccessQueryPreamble(stripTrailingSemicolons(sql));
    const withLike = translateAccessLikeExpressions(withPreamble);
    const withFunctions = translateAccessFunctions(withLike);
    const protectedSql = protectAccessSqlRegions(withFunctions);
    const code = protectedSql.code
        .replace(/\bDISTINCTROW\b/gi, 'DISTINCT')
        .replace(/\bCOUNTER\b/gi, 'INTEGER')
        .replace(/\bAUTOINCREMENT\b/gi, 'INTEGER')
        .replace(/\bYESNO\b/gi, 'BOOLEAN')
        .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
        .replace(/\bMEMO\b/gi, 'VARCHAR')
        .replace(/\bLONGCHAR\b/gi, 'VARCHAR')
        .replace(/\bCURRENCY\b/gi, 'DECIMAL(19,4)')
        .replace(/\bVARBINARY\s*\([^)]*\)/gi, 'BLOB');
    const withConcat = translateAmpersandConcat(code);
    const withNulls = translateNullOrdering(withConcat);
    const withPlus = translateAccessPlusSemantics(withNulls);
    const withDates = translateAccessDateLiterals(withPlus);
    return translateTop(protectedSql.restore(withDates));
}

/**
 * Strips a leading `PARAMETERS ...;` declaration and rewrites Access
 * crosstab queries (`TRANSFORM ... PIVOT`) into DuckDB PIVOT form.
 */
function rewriteAccessQueryPreamble(sql: string): string {
    const code = sql
        .replace(
            /^PARAMETERS\s+\[[^\]]+\]\s+[A-Za-z0-9_]+(?:\s*,\s*\[[^\]]+\]\s+[A-Za-z0-9_]+)*\s*;/i,
            ' ',
        )
        .trim();
    const transform = code.match(/^TRANSFORM\s+(.+?)\s+SELECT\s+/is);
    if (!transform) {
        return code;
    }
    const agg = transform[1]!.trim();
    const rest = code.slice(transform[0]!.length);
    const pivot = rest.match(
        /\s+PIVOT\s+(\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_.]*)(?:\s+IN\s*\(([^)]*)\))?\s*$/is,
    );
    if (!pivot) {
        return code;
    }
    const pivotColumn = pivot[1]!;
    const inList = pivot[2]
        ? ` IN (${pivot[2]!.trim().replace(/"([^"]+)"/g, "'$1'")})`
        : '';
    const beforePivot = rest.slice(0, pivot.index ?? 0);
    const groupBy = beforePivot.match(/\s+GROUP\s+BY\s+(.+?)\s*$/is);
    const where = beforePivot.match(/\s+WHERE\b([\s\S]*?)(?=\s+GROUP\s+BY\b|$)/i);
    const from = beforePivot.match(/\s+FROM\b([\s\S]*?)(?=\s+WHERE\b|\s+GROUP\s+BY\b|$)/i);
    if (!from) {
        return code;
    }
    const groupByClause = groupBy ? ` GROUP BY ${groupBy[1]!.trim()}` : '';
    const whereClause = where ? ` WHERE ${where[1]!.trim()}` : '';
    const source = `(SELECT * FROM ${from[1]!.trim()}${whereClause})`;
    return `SELECT * FROM (PIVOT ${source} ON ${pivotColumn}${inList} USING ${agg}${groupByClause})`;
}

/**
 * Access sorts NULLs first in ascending ORDER BY and last in descending
 * order; DuckDB defaults are the opposite.  Rewrites simple ORDER BY lists
 * (identifiers/aliases, optional ASC/DESC) with explicit NULLS placement.
 * Clauses containing parenthesised expressions or protected regions are left
 * untouched to avoid corrupting complex queries.
 */
function translateNullOrdering(code: string): string {
    return code.replace(/\bORDER\s+BY\b([^;]*)/gi, (match, body: string) => {
        const trimmed = body.trim();
        if (!trimmed || trimmed.includes('\uE000') || /[()]/.test(trimmed)) {
            return match;
        }
        const rewritten = trimmed
            .split(',')
            .map(part => part.trim())
            .filter(Boolean)
            .map(part => {
                if (/\bNULLS\s+(FIRST|LAST)\b/i.test(part)) {
                    return part;
                }
                const direction = /^(.*?)\s+(ASC|DESC)\s*$/i.exec(part);
                if (!direction) {
                    if (/^[A-Za-z0-9_".$]+$/.test(part)) {
                        return `${part} NULLS FIRST`;
                    }
                    return part;
                }
                const base = direction[1]!.trim();
                if (/^[A-Za-z0-9_".$]+$/.test(base)) {
                    const dir = direction[2]!.toUpperCase();
                    return `${base} ${dir} ${/^DESC$/i.test(dir) ? 'NULLS LAST' : 'NULLS FIRST'}`;
                }
                return part;
            });
        return `ORDER BY ${rewritten.join(', ')}`;
    });
}

/**
 * Rewrites Access '&' concatenation chains to DuckDB concat().  Unlike `||`,
 * DuckDB concat treats NULL as an empty string, matching Access '&'.
 *
 * The old implementation only recognized atomic operands.  This scanner uses
 * balanced parentheses and SQL clause boundaries, so function calls and
 * parenthesized/arithmetic expressions remain intact as operands too.  The
 * input has protected literals/identifiers, represented by private-use
 * markers, so quoted text and identifiers cannot be mistaken for operators.
 */
function translateAmpersandConcat(code: string): string {
    const hardBoundaryWords = new Set([
        'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
        'UNION', 'EXCEPT', 'INTERSECT', 'JOIN', 'ON', 'AND', 'OR', 'AS', 'IN',
        'IS', 'LIKE', 'BETWEEN', 'VALUES', 'SET', 'UPDATE', 'DELETE', 'INSERT',
        'INTO',
    ]);

    const wordBefore = (source: string, endExclusive: number): { start: number; word: string } | undefined => {
        let end = endExclusive;
        while (end > 0 && /\s/.test(source[end - 1]!)) end--;
        let start = end;
        while (start > 0 && /[A-Za-z_]/.test(source[start - 1]!)) start--;
        return start === end ? undefined : { start, word: source.slice(start, end).toUpperCase() };
    };

    const wordAfter = (source: string, start: number): string | undefined => {
        let index = start;
        while (index < source.length && /\s/.test(source[index]!)) index++;
        const wordStart = index;
        while (index < source.length && /[A-Za-z_]/.test(source[index]!)) index++;
        return wordStart === index ? undefined : source.slice(wordStart, index).toUpperCase();
    };

    const expressionStart = (source: string, operator: number): number => {
        let index = operator - 1;
        let nested = 0;
        while (index >= 0) {
            if (source[index] === '\uE001') {
                const markerStart = source.lastIndexOf('\uE000', index);
                index = markerStart >= 0 ? markerStart - 1 : index - 1;
                continue;
            }
            const character = source[index]!;
            if (character === ')') {
                nested++;
                index--;
                continue;
            }
            if (character === '(') {
                if (nested === 0) break;
                nested--;
                index--;
                continue;
            }
            if (nested === 0 && ',;=<>'.includes(character)) break;
            if (nested === 0 && /\s/.test(character)) {
                const previousWord = wordBefore(source, index);
                if (previousWord && hardBoundaryWords.has(previousWord.word)) {
                    return index + 1;
                }
            }
            index--;
        }
        return index + 1;
    };

    const expressionEnd = (source: string, operator: number): number => {
        let index = operator + 1;
        let nested = 0;
        while (index < source.length) {
            if (source[index] === '\uE000') {
                const markerEnd = source.indexOf('\uE001', index + 1);
                index = markerEnd >= 0 ? markerEnd + 1 : index + 1;
                continue;
            }
            const character = source[index]!;
            if (character === '(') {
                nested++;
                index++;
                continue;
            }
            if (character === ')') {
                if (nested === 0) break;
                nested--;
                index++;
                continue;
            }
            if (nested === 0 && ',;=<>'.includes(character)) break;
            if (nested === 0 && /\s/.test(character)) {
                const nextWord = wordAfter(source, index + 1);
                if (nextWord && hardBoundaryWords.has(nextWord)) break;
            }
            index++;
        }
        return index;
    };

    const splitChain = (expression: string): string[] => {
        const parts: string[] = [];
        let start = 0;
        let nested = 0;
        let index = 0;
        while (index < expression.length) {
            if (expression[index] === '\uE000') {
                const markerEnd = expression.indexOf('\uE001', index + 1);
                index = markerEnd >= 0 ? markerEnd + 1 : index + 1;
                continue;
            }
            const character = expression[index]!;
            if (character === '(') nested++;
            else if (character === ')') nested = Math.max(0, nested - 1);
            else if (character === '&' && nested === 0) {
                parts.push(expression.slice(start, index).trim());
                start = index + 1;
            }
            index++;
        }
        parts.push(expression.slice(start).trim());
        return parts;
    };

    const findAmpersand = (source: string, start: number): number => {
        let index = start;
        while (index < source.length) {
            if (source[index] === '\uE000') {
                const markerEnd = source.indexOf('\uE001', index + 1);
                index = markerEnd >= 0 ? markerEnd + 1 : index + 1;
                continue;
            }
            if (source[index] === '&') return index;
            index++;
        }
        return -1;
    };

    let result = code;
    let searchFrom = 0;
    for (let iteration = 0; iteration < 1000; iteration++) {
        const operator = findAmpersand(result, searchFrom);
        if (operator < 0) return result;
        const start = expressionStart(result, operator);
        const end = expressionEnd(result, operator);
        const parts = splitChain(result.slice(start, end));
        if (parts.length < 2 || parts.some(part => part.length === 0)) {
            result = `${result.slice(0, operator)}||${result.slice(operator + 1)}`;
            searchFrom = operator + 2;
            continue;
        }
        const replacement = `concat(${parts.map(part => translateAmpersandConcat(part)).join(', ')})`;
        result = `${result.slice(0, start)}${replacement}${result.slice(end)}`;
        searchFrom = start + replacement.length;
    }
    return result;
}

/**
 * Access uses `+` as numeric addition, even when one of the operands is text.
 * Such expressions yield Null when the text cannot be coerced to a number;
 * DuckDB otherwise rejects them during binding. Preserve ordinary numeric
 * arithmetic and use TRY_CAST only for simple chains containing a protected
 * literal/identifier operand.
 */
function translateAccessPlusSemantics(code: string): string {
    const operand = '(?:\\uE000\\d+\\uE001|[A-Za-z_][A-Za-z0-9_.$]*|-?\\d+(?:\\.\\d+)?)';
    const chain = new RegExp(`(${operand}(?:\\s*\\+\\s*${operand})+)`, 'g');
    return code.replace(chain, match => {
        const parts = match.split(/\s*\+\s*/);
        if (!parts.some(part => part.includes('\uE000'))) return match;
        return parts.map(part => `try_cast(${part} AS DOUBLE)`).join(' + ');
    });
}

function duckDbType(column: AccessColumnDefinition): string {
    switch (column.accessType) {
        case 'boolean':
            return 'BOOLEAN';
        case 'byte':
            return 'UTINYINT';
        case 'integer':
            return 'SMALLINT';
        case 'long':
            return 'INTEGER';
        case 'bigint':
            return 'BIGINT';
        case 'currency':
            return 'DECIMAL(19,4)';
        case 'float':
            return 'REAL';
        case 'double':
            return 'DOUBLE';
        case 'datetime':
        case 'datetimextended':
            return 'TIMESTAMP';
        case 'numeric': {
            const precision = column.precision ?? 18;
            const scale = column.scale ?? 0;
            return `DECIMAL(${Math.max(1, precision)},${Math.max(0, Math.min(scale, precision))})`;
        }
        case 'binary':
        case 'ole':
            return 'BLOB';
        case 'complex':
        case 'memo':
        case 'text':
        case 'repid':
            return 'VARCHAR';
        default:
            return 'VARCHAR';
    }
}

function normalizeValue(value: AccessValue, duckdb: DuckDbModule): DuckDBValue {
    if (Array.isArray(value)) {
        return serializeAccessComplexValue(value as AccessComplexValue);
    }
    if (value instanceof Date) {
        return duckdb.timestampValue(BigInt(value.getTime()) * 1000n);
    }
    if (value instanceof Uint8Array) {
        return duckdb.blobValue(Uint8Array.from(value));
    }
    return value as Exclude<AccessScalarValue, Date | Uint8Array>;
}

function sequenceName(definition: AccessTableDefinition, column: AccessColumnDefinition): string {
    const source = `${definition.name}\u0000${column.name}`;
    let hash = 2166136261;
    for (const character of source) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
    }
    return `__access_sequence_${(hash >>> 0).toString(16)}`;
}

function isTextLike(column: AccessColumnDefinition): boolean {
    return (
        column.accessType === 'text' ||
        column.accessType === 'memo' ||
        column.accessType === 'repid'
    );
}

const ACCESS_DEFAULT_FUNCTIONS: Readonly<Record<string, string>> = {
    date: 'current_date',
    now: 'current_timestamp',
    time: 'current_time',
};

/**
 * Translates an Access `DefaultValue` expression into a DuckDB expression.
 *
 * Access stores the raw expression, so an omitted INSERT column must get the
 * same value Access would store.  Only literals and a few zero-argument
 * functions are translatable; anything else (domain functions, field
 * references, `DLookup`, concatenation) returns undefined so the mirror keeps
 * the column without a default instead of failing to load the table.
 */
export function translateAccessDefaultExpression(
    expression: string | undefined,
    accessType: string,
): string | undefined {
    let source = expression?.trim();
    if (!source) {
        return undefined;
    }
    if (source.startsWith('=')) {
        // A leading "=" is the Access expression marker, not an operator.
        source = source.slice(1).trim();
    }
    if (!source) {
        return undefined;
    }

    const quoted = /^"(?:[^"]|"")*"$/.test(source) || /^'(?:[^']|'')*'$/.test(source);
    if (quoted) {
        const body = decodeAccessQuotedText(source).replace(/'/g, "''");
        return `'${body}'`;
    }

    if (/^#.*#$/.test(source)) {
        return translateAccessDateLiterals(source);
    }

    let unwrapped = source;
    while (/^\((?:[^()]|\([^()]*\))*\)$/.test(unwrapped)) {
        unwrapped = unwrapped.slice(1, -1).trim();
    }
    if (accessType === 'boolean') {
        // Access stores True/False as -1/0 in some paths and as Yes/No words in
        // others; both mean the boolean, and the numeric branch below must not
        // treat a numeric 0 as a boolean on a non-boolean column.
        if (/^(?:true|yes|on|-1|1)$/i.test(unwrapped)) {
            return 'TRUE';
        }
        if (/^(?:false|no|off|0)$/i.test(unwrapped)) {
            return 'FALSE';
        }
        return undefined;
    }
    if (isDateLike(accessType)) {
        // A bare number on a date column is an Access date serial; DuckDB
        // cannot cast it to TIMESTAMP, and guessing the epoch would silently
        // store a different date.  Date functions are handled below.
        if (/^[+-]?\d+(?:[.,]\d+)?$/.test(unwrapped)) {
            return undefined;
        }
    } else if (/^[+-]?\d+(?:[.,]\d+)?$/.test(unwrapped)) {
        return unwrapped.replace(',', '.');
    }

    const functionCall = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)$/.exec(unwrapped);
    const duckDbFunction = functionCall ? ACCESS_DEFAULT_FUNCTIONS[functionCall[1].toLowerCase()] : undefined;
    if (duckDbFunction && (isDateLike(accessType) || accessType === 'text' || accessType === 'memo')) {
        // `Date()` is a date, `Now()` a timestamp; the column type decides the
        // literal cast DuckDB accepts.  Date functions on a numeric column are
        // not valid Access defaults either, so they stay unsupported there.
        return duckDbFunction === 'current_date' && isDateLike(accessType)
            ? 'CAST(current_date AS TIMESTAMP)'
            : duckDbFunction;
    }

    return undefined;
}

function isDateLike(accessType: string): boolean {
    return accessType === 'datetime' || accessType === 'datetimextended';
}

function columnDefaultSql(definition: AccessTableDefinition, column: AccessColumnDefinition): string {
    if (column.autoLong && column.accessType !== 'complex') {
        return ` DEFAULT nextval('${sequenceName(definition, column)}')`;
    }
    if (column.autoUuid) {
        return ' DEFAULT uuid()';
    }
    const translated = translateAccessDefaultExpression(column.defaultValue, column.accessType);
    return translated === undefined ? '' : ` DEFAULT ${translated}`;
}

/** Schema pieces the mirror reproduces for one table. */
export interface AccessMirrorTableSchema {
    readonly definition: AccessTableDefinition;
    readonly keys: readonly AccessMirrorKeyPlan[];
    readonly references: readonly AccessMirrorReferencePlan[];
    /** Columns that must reject NULL because of an index (`WITH DISALLOW NULL`). */
    readonly requiredColumns: ReadonlySet<string>;
}

/** Human-readable list of what a fallback schema still enforces. */
function describeAccessMirrorLevel(options: AccessMirrorTableSqlOptions): string {
    const parts: string[] = [];
    if (options.includeValidation) parts.push('validation rules');
    if (options.includeKeys) parts.push('keys');
    if (options.includeReferences) parts.push('foreign keys');
    return parts.length === 0 ? 'no constraints' : parts.join(', ');
}

export interface AccessMirrorTableSqlOptions {
    readonly includeValidation: boolean;
    readonly includeKeys: boolean;
    readonly includeReferences: boolean;
}

/**
 * `CREATE TABLE` for one mirrored table.
 *
 * Keys come from the file's own indexes rather than from `nullable`, and a
 * primary key is not spelled `PRIMARY KEY` when it contains text: Access
 * compares text keys case- and trailing-space-insensitively, which only a
 * unique index over `lower(rtrim(column, ' '))` reproduces.  Such a key is
 * enforced by `accessMirrorKeyIndexes` plus `NOT NULL` on its columns.
 */
export function buildAccessMirrorTableSql(
    schema: AccessMirrorTableSchema,
    options: AccessMirrorTableSqlOptions,
): string {
    const { definition } = schema;
    const required = options.includeKeys ? schema.requiredColumns : undefined;
    const columns = definition.columns.map(column => {
        const notNull = !column.nullable || required?.has(column.name) ? ' NOT NULL' : '';
        const defaultValue = columnDefaultSql(definition, column);
        const collation = isTextLike(column) ? ' COLLATE NOCASE' : '';
        return `${quoteIdentifier(column.name)} ${duckDbType(column)}${collation}${defaultValue}${notNull}`;
    });
    if (columns.length === 0) {
        throw new AccessFileError(`Access table '${definition.name}' has no columns.`);
    }
    if (options.includeKeys) {
        for (const key of schema.keys) {
            if (key.asConstraint) {
                // Non-text keys compare identically in both engines, so a real
                // table constraint is both accurate and readable.
                columns.push(accessMirrorKeyConstraintSql(key));
            }
        }
    }
    if (options.includeReferences) {
        for (const reference of schema.references) {
            columns.push(accessMirrorReferenceSql(reference));
            for (const guard of reference.nullGuards) {
                columns.push(`CHECK ${guard}`);
            }
        }
    }
    if (options.includeValidation) {
        // Field-level and record-level ValidationRule properties become CHECK
        // constraints so the mirror rejects the same values Access rejects.
        // AllowZeroLength=False is the one validation flag Access keeps as a
        // boolean; it rejects '' but still accepts NULL.  It only means
        // something for text columns, so numeric columns never get that CHECK.
        for (const column of definition.columns) {
            if (column.allowZeroLength === false && isTextLike(column)) {
                columns.push(`CHECK ${buildAccessZeroLengthCheck(column.name)}`);
            }
        }
        for (const check of buildAccessCheckConstraints(definition.columns, definition.validationRule)) {
            columns.push(`CHECK ${check}`);
        }
    }
    return `CREATE TABLE ${quoteIdentifier(definition.name)} (${columns.join(', ')})`;
}

async function loadDuckDb(): Promise<DuckDbModule> {
    if (!duckDbModulePromise) {
        duckDbModulePromise = Promise.resolve()
            .then(() => extensionRequire('@duckdb/node-api') as DuckDbModule)
            .catch(error => {
                duckDbModulePromise = undefined;
                throw new AccessFileError(
                    'DuckDB runtime dependency "@duckdb/node-api" is not installed for the Access extension.',
                    { cause: error },
                );
            });
    }
    return duckDbModulePromise;
}

export class AccessDuckDbMirror {
    private _instance?: DuckDBInstance;
    private _connection?: DuckDbRuntimeConnection;
    private readonly _warnings: string[] = [];

    /** Non-fatal messages from mirror construction, for logs and diagnostics. */
    public get warnings(): readonly string[] {
        return this._warnings;
    }

    public async open(session: AccessFileSession): Promise<void> {
        const duckdb = await loadDuckDb();
        // A reconnect reuses the mirror instance; warnings describe the file
        // currently open, so stale messages from the previous session would be
        // misleading.
        this._warnings.length = 0;
        const instance = await duckdb.DuckDBInstance.create();
        try {
            const connection = await instance.connect();
            this._instance = instance;
            this._connection = connection;
            await this.loadTables(session, duckdb);
            for (const query of session.listQueryDefinitions()) {
                if (query.type !== 'select' || query.hasParameters || !query.sql) {
                    continue;
                }
                try {
                    await connection.run(`CREATE VIEW ${quoteIdentifier(query.name)} AS ${translateAccessSql(query.sql)}`);
                } catch {
                    // Keep the base tables usable when a saved query uses an
                    // Access-only construct that the DuckDB mirror cannot
                    // translate yet.
                }
            }
        } catch (error) {
            connectionCleanup(instance);
            this._instance = undefined;
            this._connection = undefined;
            throw new AccessFileError(
                `Cannot build the Access DuckDB mirror: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    public async close(): Promise<void> {
        const connection = this._connection;
        const instance = this._instance;
        this._connection = undefined;
        this._instance = undefined;
        connection?.disconnectSync();
        instance?.closeSync();
    }

    public async execute(sql: string): Promise<AccessMirrorResult> {
        const connection = this.requireRuntimeConnection();
        const translated = translateAccessSql(sql);
        if (/^(?:SELECT|WITH|VALUES|PRAGMA|DESCRIBE|SHOW)\b/i.test(translated)) {
            const result = await connection.stream(translated);
            return {
                columns: readColumns(result),
                rowChunks: result.yieldRowsJs(),
                recordsAffected: -1,
            };
        }

        const result = await connection.run(translated);
        return { columns: [], rows: [], recordsAffected: result.rowsChanged };
    }

    public async executeAndReadAll(sql: string): Promise<AccessMirrorResult> {
        const result = await this.execute(sql);
        if (!result.rowChunks) {
            return result;
        }
        const rows: unknown[][] = [];
        for await (const chunk of result.rowChunks) {
            rows.push(...chunk.map(row => [...row]));
        }
        return { columns: result.columns, rows, recordsAffected: result.recordsAffected };
    }

    public async snapshotTables(definitions: readonly AccessTableDefinition[]): Promise<AccessTableSnapshot[]> {
        const snapshots: AccessTableSnapshot[] = [];
        for (const definition of definitions) {
            const selectedColumns = definition.columns.map(column => {
                const identifier = quoteIdentifier(column.name);
                return column.accessType === 'currency' || column.accessType === 'numeric'
                    ? `CAST(${identifier} AS VARCHAR) AS ${identifier}`
                    : identifier;
            });
            const execution = await this.readInternalAndReadAll(
                `SELECT ${selectedColumns.join(', ')} FROM ${quoteIdentifier(definition.name)}`,
            );
            snapshots.push({
                definition,
                rows: (execution.rows ?? []).map(row => row.map((value, index) => snapshotValue(
                    value,
                    definition.columns[index],
                ))),
            });
        }
        return snapshots;
    }

    public interrupt(): void {
        this._connection?.interrupt();
    }

    public async readObjectColumns(name: string): Promise<AccessMirrorColumn[]> {
        const result = await this.requireRuntimeConnection().stream(
            `SELECT * FROM ${quoteIdentifier(name)} LIMIT 0`,
        );
        return readColumns(result);
    }

    private async loadTables(session: AccessFileSession, duckdb: DuckDbModule): Promise<void> {
        const definitions = session.listTables();
        const keysByTable = new Map<string, readonly AccessMirrorKeyPlan[]>();
        const requiredByTable = new Map<string, ReadonlySet<string>>();
        for (const definition of definitions) {
            const plan = planAccessMirrorKeys(definition, this.readIndexes(session, definition));
            keysByTable.set(definition.name.toLowerCase(), plan.keys);
            requiredByTable.set(definition.name.toLowerCase(), new Set(plan.requiredColumns));
            this._warnings.push(...plan.warnings);
        }
        const references = planAccessMirrorReferences({
            definitions,
            relationships: this.readRelationships(session),
            keysByTable,
            typeOf: duckDbType,
        });
        this._warnings.push(...references.warnings);

        const order = orderTablesForMirror(
            definitions.map(definition => definition.name),
            references.dependencies,
        );
        const byName = new Map(definitions.map(definition => [definition.name.toLowerCase(), definition]));
        // A reference is only emitted when the parent already exists; a cycle
        // would otherwise need a table that the plan has not created yet.
        const created = new Set<string>();
        for (const name of order) {
            const lower = name.toLowerCase();
            const definition = byName.get(lower);
            if (!definition) continue;
            const planned = references.references.filter(reference =>
                reference.childTable.toLowerCase() === lower);
            const usable = planned.filter(reference => created.has(reference.parentTable.toLowerCase()));
            for (const reference of planned) {
                if (!usable.includes(reference)) {
                    this._warnings.push(
                        `Relationship '${reference.accessName}' was mirrored without a foreign key: `
                        + `table '${reference.parentTable}' is created later (cyclic reference).`,
                    );
                }
            }
            await this.loadTable(session, definition, duckdb, {
                definition,
                keys: keysByTable.get(lower) ?? [],
                references: usable,
                requiredColumns: requiredByTable.get(lower) ?? new Set<string>(),
            });
            created.add(lower);
        }
    }

    /**
     * Indexes are read from the file itself; a table whose index chain cannot
     * be parsed simply mirrors without keys instead of failing the open.
     */
    private readIndexes(
        session: AccessFileSession,
        definition: AccessTableDefinition,
    ): readonly AccessIndexDefinition[] {
        try {
            return session.listIndexes(definition.name);
        } catch {
            this._warnings.push(
                `Table '${definition.name}' was mirrored without keys: the file index chain could not be read.`,
            );
            return [];
        }
    }

    private readRelationships(session: AccessFileSession): readonly AccessRelationshipDefinition[] {
        try {
            return session.listRelationships();
        } catch {
            this._warnings.push('The file relationships could not be read; the mirror has no foreign keys.');
            return [];
        }
    }

    private async loadTable(
        session: AccessFileSession,
        definition: AccessTableDefinition,
        duckdb: DuckDbModule,
        schema: AccessMirrorTableSchema,
    ): Promise<void> {
        const connection = this.requireRuntimeConnection();
        const snapshot: AccessTableSnapshot = await session.readTable(definition.name);
        for (const column of definition.columns.filter(candidate => candidate.autoLong && candidate.accessType !== 'complex')) {
            const columnIndex = definition.columns.indexOf(column);
            const maximum = snapshot.rows.reduce((current, row) => {
                const value = row[columnIndex];
                const numeric = typeof value === 'bigint' ? Number(value) : Number(value);
                return Number.isFinite(numeric) ? Math.max(current, numeric) : current;
            }, 0);
            await connection.run(
                `CREATE SEQUENCE ${quoteIdentifier(sequenceName(definition, column))} START WITH ${Math.max(1, Math.trunc(maximum) + 1)}`,
            );
        }
        // Every constraint layer is advisory: an Access rule that DuckDB
        // cannot evaluate, legacy rows that already violate a stored rule or
        // index, and a constraint the mirror cannot express must not stop the
        // file from opening.  Try the fully constrained schema first, then
        // drop one layer at a time and record why.
        const levels: readonly AccessMirrorTableSqlOptions[] = [
            { includeValidation: true, includeKeys: true, includeReferences: true },
            { includeValidation: false, includeKeys: true, includeReferences: true },
            { includeValidation: false, includeKeys: true, includeReferences: false },
            { includeValidation: false, includeKeys: false, includeReferences: false },
        ];
        let lastError: unknown;
        for (let index = 0; index < levels.length; index++) {
            const options = levels[index]!;
            try {
                await this.createTableWithRows(schema, snapshot, duckdb, options);
                if (index > 0) {
                    this._warnings.push(
                        `Table '${definition.name}' was mirrored with reduced constraints `
                        + `(${describeAccessMirrorLevel(options)}): `
                        + (lastError instanceof Error ? lastError.message : String(lastError)),
                    );
                }
                return;
            } catch (error) {
                lastError = error;
                await connection.run(`DROP TABLE IF EXISTS ${quoteIdentifier(definition.name)}`);
            }
        }
        throw new AccessFileError(
            `Access table '${definition.name}' could not be mirrored: `
            + (lastError instanceof Error ? lastError.message : String(lastError)),
            { cause: lastError },
        );
    }

    private async createTableWithRows(
        schema: AccessMirrorTableSchema,
        snapshot: AccessTableSnapshot,
        duckdb: DuckDbModule,
        options: AccessMirrorTableSqlOptions,
    ): Promise<void> {
        const connection = this.requireRuntimeConnection();
        const { definition } = schema;
        await connection.run(buildAccessMirrorTableSql(schema, options));
        if (snapshot.rows.length === 0) {
            await this.createKeyIndexes(schema, options);
            return;
        }
        const placeholders = snapshot.definition.columns.map(() => '?').join(', ');
        const maxRowsPerBatch = Math.max(1, Math.floor(1000 / snapshot.definition.columns.length));
        for (let start = 0; start < snapshot.rows.length; start += maxRowsPerBatch) {
            const batch = snapshot.rows.slice(start, start + maxRowsPerBatch);
            const values = batch.flatMap(row => row.map(value => normalizeValue(value, duckdb)));
            const rowPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
            await connection.run(
                `INSERT INTO ${quoteIdentifier(definition.name)} VALUES ${rowPlaceholders}`,
                values,
            );
        }
        await this.createKeyIndexes(schema, options);
    }

    /**
     * Text keys are enforced by a unique index over the Access comparison
     * expression, which cannot be a table constraint.  Legacy rows that already
     * contain duplicates fail here, which is what triggers the reduced schema.
     */
    private async createKeyIndexes(
        schema: AccessMirrorTableSchema,
        options: AccessMirrorTableSqlOptions,
    ): Promise<void> {
        if (!options.includeKeys) {
            return;
        }
        const connection = this.requireRuntimeConnection();
        for (const key of schema.keys) {
            if (key.asConstraint) {
                continue;
            }
            await connection.run(accessMirrorKeyIndexSql(schema.definition.name, key));
        }
    }

    private async readInternalAndReadAll(sql: string): Promise<AccessMirrorResult> {
        const result = await this.requireRuntimeConnection().stream(sql);
        const rows: unknown[][] = [];
        for await (const chunk of result.yieldRowsJs()) {
            rows.push(...chunk.map(row => [...row]));
        }
        return {
            columns: readColumns(result),
            rows,
            recordsAffected: -1,
        };
    }

    private requireConnection(): DuckDbRuntimeConnection {
        if (!this._connection) {
            throw new AccessFileError('Access DuckDB mirror is not open.');
        }
        return this._connection;
    }

    private requireRuntimeConnection(): DuckDbConnectionLike {
        return this.requireConnection() as unknown as DuckDbConnectionLike;
    }
}

function snapshotValue(value: unknown, column: AccessColumnDefinition | undefined): AccessValue {
    if (value === null || value === undefined) return null;
    if (column?.accessType === 'currency' || column?.accessType === 'numeric') {
        return String(value);
    }
    if (value instanceof Date) return value;
    if (value instanceof Uint8Array) return Uint8Array.from(value);
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
        return value;
    }
    return String(value);
}

function readColumns(result: DuckDbResultLike): AccessMirrorColumn[] {
    return Array.from({ length: result.columnCount }, (_, index) => ({
        name: result.columnName(index),
        type: result.columnType(index).toString(),
    }));
}

function connectionCleanup(instance: DuckDBInstance): void {
    try {
        instance.closeSync();
    } catch {
        // Preserve the connection error.
    }
}
