import { findNestedBlockCommentEnd } from '../sql/sqlSourceScan';
import { SqlParser } from '../sql/sqlParser';

type RetrySqlTokenKind = 'word' | 'quotedIdentifier' | 'leftParen' | 'other';

interface RetrySqlToken {
    kind: RetrySqlTokenKind;
    word?: string;
}

interface RetrySqlScan {
    tokens: RetrySqlToken[];
    valid: boolean;
}

function isRetryIdentifierStart(char: string): boolean {
    return /[A-Za-z_\p{L}\p{Nl}]/u.test(char);
}

function isRetryIdentifierPart(char: string): boolean {
    return /[A-Za-z0-9_$#\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}]/u.test(char);
}

function consumeQuotedToken(
    sql: string,
    start: number,
    opening: string,
    closing: string = opening,
): number | undefined {
    for (let index = start + 1; index < sql.length; index += 1) {
        const char = sql[index];
        if (char === '\\' && opening !== '[' && index + 1 < sql.length) {
            // MySQL permits backslash escapes in quoted identifiers. Treating
            // the same form as escaped for the other quote styles is safer
            // than accidentally treating the remainder as executable SQL.
            index += 1;
            continue;
        }
        if (char !== closing) {
            continue;
        }
        if (sql[index + 1] === closing) {
            // SQL doubles the closing delimiter to represent it in a quoted
            // identifier/literal: "a""b", [a]]b], or `a``b`.
            index += 1;
            continue;
        }
        return index + 1;
    }
    return undefined;
}

/** Return the end of a PostgreSQL dollar-quoted literal, or undefined. */
function consumeDollarQuotedLiteral(sql: string, start: number): number | undefined {
    if (sql[start] !== '$') {
        return undefined;
    }

    let delimiterEnd = start + 1;
    if (sql[delimiterEnd] === '$') {
        delimiterEnd += 1;
    } else {
        if (!/[A-Za-z_]/u.test(sql[delimiterEnd] ?? '')) {
            return undefined;
        }
        delimiterEnd += 1;
        while (/[A-Za-z0-9_]/u.test(sql[delimiterEnd] ?? '')) {
            delimiterEnd += 1;
        }
        if (sql[delimiterEnd] !== '$') {
            return undefined;
        }
        delimiterEnd += 1;
    }

    const delimiter = sql.slice(start, delimiterEnd);
    const closingDelimiter = sql.indexOf(delimiter, delimiterEnd);
    return closingDelimiter < 0
        ? undefined
        : closingDelimiter + delimiter.length;
}

/** Return the end of a PostgreSQL positional parameter, or undefined. */
function consumePositionalParameter(sql: string, start: number): number | undefined {
    if (sql[start] !== '$' || !/\d/u.test(sql[start + 1] ?? '')) {
        return undefined;
    }

    let end = start + 2;
    while (/\d/u.test(sql[end] ?? '')) {
        end += 1;
    }

    // `$1name` is not a valid positional parameter followed by an identifier.
    // Reject it instead of silently scanning two unrelated tokens.
    return isRetryIdentifierPart(sql[end] ?? '') ? undefined : end;
}

function scanRetrySql(sql: string): RetrySqlScan {
    const tokens: RetrySqlToken[] = [];

    for (let index = 0; index < sql.length;) {
        const char = sql[index] ?? '';
        const next = sql[index + 1] ?? '';

        if (/\s/u.test(char)) {
            index += 1;
            continue;
        }

        if (char === '#') {
            if (next === '>') {
                // PostgreSQL JSON path operators are executable operators, not
                // MySQL-style comments. A standalone '#' remains ambiguous and
                // is rejected below. Function calls in either operand are still
                // caught by the normal call-shaped token check.
                tokens.push({ kind: 'other' });
                index += sql[index + 2] === '>' ? 3 : 2;
                continue;
            }
            // '#' is a MySQL line-comment delimiter, but other '#' forms are
            // dialect-dependent. Without a dialect at this shared boundary,
            // reject them rather than replaying an ambiguous interpretation as
            // if it were harmless.
            return { tokens, valid: false };
        }

        if (char === '-' && next === '-') {
            if (sql[index + 2] !== undefined && !/\s/u.test(sql[index + 2] ?? '')) {
                // MySQL only recognizes `--` as a comment delimiter when it
                // is followed by whitespace/control text. Other supported
                // dialects accept `--text`, so reject the ambiguous form at
                // this dialect-neutral boundary.
                return { tokens, valid: false };
            }
            const lineEnd = sql.slice(index + 2).search(/[\r\n]/u);
            if (lineEnd < 0) {
                return { tokens, valid: true };
            }
            index += 2 + lineEnd;
            continue;
        }

        if (char === '/' && next === '*') {
            if (sql[index + 2] === '!') {
                // MySQL executable comments are code, not discardable
                // comments. Their dialect-specific payload is intentionally
                // not interpreted by this shared scanner.
                return { tokens, valid: false };
            }
            const commentEnd = findNestedBlockCommentEnd(sql, index);
            if (commentEnd === undefined) {
                return { tokens, valid: false };
            }
            index = commentEnd;
            continue;
        }

        if (char === "'") {
            const literalEnd = consumeQuotedToken(sql, index, "'");
            if (literalEnd === undefined) {
                return { tokens, valid: false };
            }
            index = literalEnd;
            continue;
        }

        if (char === '$') {
            const parameterEnd = consumePositionalParameter(sql, index);
            if (parameterEnd !== undefined) {
                // PostgreSQL positional parameters are values, not executable
                // SQL. Treat `$1` as an opaque token while retaining the
                // conservative handling of every other leading '$' form.
                index = parameterEnd;
                continue;
            }
            // PostgreSQL dollar-quoted literals can contain arbitrary SQL
            // punctuation, including quotes and call-shaped text. Recognize
            // complete literals; reject every other leading '$' form as
            // dialect-dependent syntax that is unsafe to replay blindly.
            const literalEnd = consumeDollarQuotedLiteral(sql, index);
            if (literalEnd === undefined) {
                return { tokens, valid: false };
            }
            index = literalEnd;
            continue;
        }

        if (char === '"' || char === '`') {
            const identifierEnd = consumeQuotedToken(sql, index, char);
            if (identifierEnd === undefined) {
                return { tokens, valid: false };
            }
            tokens.push({ kind: 'quotedIdentifier' });
            index = identifierEnd;
            continue;
        }

        if (char === '[') {
            const identifierEnd = consumeQuotedToken(sql, index, '[', ']');
            if (identifierEnd === undefined) {
                return { tokens, valid: false };
            }
            tokens.push({ kind: 'quotedIdentifier' });
            index = identifierEnd;
            continue;
        }

        if (isRetryIdentifierStart(char)) {
            const wordStart = index;
            index += 1;
            while (index < sql.length && isRetryIdentifierPart(sql[index] ?? '')) {
                index += 1;
            }
            tokens.push({
                kind: 'word',
                word: sql.slice(wordStart, index).toUpperCase(),
            });
            continue;
        }

        if (char === '(') {
            tokens.push({ kind: 'leftParen' });
        } else {
            tokens.push({ kind: 'other' });
        }
        index += 1;
    }

    return { tokens, valid: true };
}

function hasWordSequence(words: readonly string[], sequence: readonly string[]): boolean {
    if (sequence.length === 0 || words.length < sequence.length) {
        return false;
    }
    for (let index = 0; index <= words.length - sequence.length; index += 1) {
        if (sequence.every((word, sequenceIndex) => words[index + sequenceIndex] === word)) {
            return true;
        }
    }
    return false;
}

function hasStatefulExpression(body: string): boolean {
    const scan = scanRetrySql(body);
    if (!scan.valid) {
        // Unterminated strings, quoted identifiers, or comments are unknown
        // syntax and must never become an automatic replay.
        return true;
    }

    const words = scan.tokens
        .filter((token): token is RetrySqlToken & { kind: 'word'; word: string } =>
            token.kind === 'word' && token.word !== undefined)
        .map(token => token.word);
    if (words.includes('NEXTVAL') || words.includes('SETVAL') || hasWordSequence(words, ['NEXT', 'VALUE', 'FOR'])) {
        return true;
    }

    // A user-defined function may mutate database state. Without resolved
    // function metadata, any call-shaped expression is ambiguous. The token
    // scan deliberately includes quoted identifiers used by Netezza, SQL
    // Server, and MySQL, while ignoring names inside comments and literals.
    if (scan.tokens.some((token, index) =>
        (token.kind === 'word' || token.kind === 'quotedIdentifier')
        && scan.tokens[index + 1]?.kind === 'leftParen')) {
        return true;
    }

    return hasWordSequence(words, ['FOR', 'UPDATE']) || hasWordSequence(words, ['FOR', 'SHARE']);
}

/** Return the first non-comment SQL offset, or undefined for invalid trivia. */
export function skipLeadingSqlTrivia(sql: string): number | undefined {
    let start = 0;
    while (start < sql.length) {
        while (start < sql.length && (sql[start] === '\uFEFF' || /\s/u.test(sql[start] ?? ''))) {
            start += 1;
        }

        if (sql.startsWith('--', start)) {
            // At the beginning of a statement, compact `--text` comments are
            // accepted by PostgreSQL, Netezza, and other supported dialects.
            // Inline compact comments remain rejected by scanRetrySql because
            // MySQL can interpret them as executable minus operators.
            const relativeLineEnd = sql.slice(start + 2).search(/[\r\n]/u);
            if (relativeLineEnd < 0) {
                return sql.length;
            }
            const lineEnd = start + 2 + relativeLineEnd;
            start = lineEnd + (sql[lineEnd] === '\r' && sql[lineEnd + 1] === '\n' ? 2 : 1);
            continue;
        }

        if (sql.startsWith('/*', start)) {
            if (sql[start + 2] === '!') {
                // MySQL executable comments contain SQL, so they cannot be
                // discarded as trivia before the retry classifier sees it.
                return undefined;
            }
            const commentEnd = findNestedBlockCommentEnd(sql, start);
            if (commentEnd === undefined) {
                return undefined;
            }
            start = commentEnd;
            continue;
        }

        break;
    }
    return start;
}

/** Return the only executable statement, ignoring comment-only fragments. */
export function getSingleExecutableStatement(sql: string): string | undefined {
    const statements = SqlParser.splitStatements(sql).filter(statement => {
        const start = skipLeadingSqlTrivia(statement);
        return start !== undefined && start < statement.length;
    });
    return statements.length === 1 ? statements[0] : undefined;
}

/**
 * Conservatively identifies statements that may be replayed after a broken
 * connection without repeating a data-changing operation.
 */
export function isSafeToRetryAfterBrokenConnection(sql: string): boolean {
    const statement = getSingleExecutableStatement(sql);
    if (statement === undefined) {
        return false;
    }

    const start = skipLeadingSqlTrivia(statement);
    if (start === undefined) {
        return false;
    }
    const executableSql = statement.slice(start);

    if (/^SELECT\b/iu.test(executableSql)) {
        // SELECT ... INTO creates or assigns state on supported engines.
        const body = executableSql.replace(/^SELECT\b/iu, '');
        const scan = scanRetrySql(body);
        if (!scan.valid) {
            return false;
        }
        const words = scan.tokens
            .filter((token): token is RetrySqlToken & { kind: 'word'; word: string } =>
                token.kind === 'word' && token.word !== undefined)
            .map(token => token.word);
        return !words.includes('INTO') && !hasStatefulExpression(body);
    }

    if (/^VALUES\b/iu.test(executableSql)) {
        return !hasStatefulExpression(executableSql.replace(/^VALUES\b/iu, ''));
    }

    if (/^(SHOW|DESCRIBE|DESC)\b/iu.test(executableSql)) {
        return true;
    }

    // EXPLAIN ANALYZE may execute the underlying statement on some engines.
    // Accept only a plain/VERBOSE plan of another allow-listed read operation.
    const explainedSql = executableSql.replace(/^EXPLAIN(?:\s+VERBOSE)?\s+/iu, '');
    return explainedSql !== executableSql
        && isSafeToRetryAfterBrokenConnection(explainedSql);
}

export function createRetrySafetyError(error: unknown, partialRowsDelivered: boolean): Error {
    if (partialRowsDelivered) {
        return new Error(
            'Connection was lost after partial results were delivered. '
            + 'The partial result was kept and the query was not retried automatically.',
            { cause: error },
        );
    }

    return new Error(
        'Connection was lost while executing SQL that could not be proven safe to retry. '
        + 'The database outcome may be unknown; verify its state before running the statement again.',
        { cause: error },
    );
}
