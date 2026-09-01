import { findNestedBlockCommentEnd } from '../sql/sqlSourceScan';
import { SqlParser } from '../sql/sqlParser';

/** Return the first non-comment SQL offset, or undefined for invalid trivia. */
export function skipLeadingSqlTrivia(sql: string): number | undefined {
    let start = 0;
    while (start < sql.length) {
        while (start < sql.length && (sql[start] === '\uFEFF' || /\s/u.test(sql[start] ?? ''))) {
            start += 1;
        }

        if (sql.startsWith('--', start)) {
            const relativeLineEnd = sql.slice(start + 2).search(/[\r\n]/u);
            if (relativeLineEnd < 0) {
                return sql.length;
            }
            const lineEnd = start + 2 + relativeLineEnd;
            start = lineEnd + (sql[lineEnd] === '\r' && sql[lineEnd + 1] === '\n' ? 2 : 1);
            continue;
        }

        if (sql.startsWith('/*', start)) {
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

    const hasStatefulExpression = (body: string): boolean => (
        /\b(?:NEXTVAL|SETVAL)\b|\bNEXT\s+VALUE\s+FOR\b/iu.test(body)
        // A user-defined function may mutate database state. Without resolved
        // function metadata, any call-shaped expression is ambiguous.
        || /\b[A-Z_][A-Z0-9_$#]*(?:\s*\.\s*[A-Z_][A-Z0-9_$#]*)*\s*\(/iu.test(body)
        || /\bFOR\s+(?:UPDATE|SHARE)\b/iu.test(body)
    );

    if (/^SELECT\b/iu.test(executableSql)) {
        // SELECT ... INTO creates or assigns state on supported engines.
        const body = executableSql.replace(/^SELECT\b/iu, '');
        return !/\bINTO\b/iu.test(body) && !hasStatefulExpression(body);
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
