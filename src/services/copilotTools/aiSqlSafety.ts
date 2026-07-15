import { SqlParser } from '../../sql/sqlParser';

const FORBIDDEN_STATEMENT_KEYWORDS = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|EXEC(?:UTE)?|COPY|GRANT|REVOKE)\b/i;

function withoutSqlStringsAndComments(sql: string): string {
    return sql
        .replace(/'(?:''|[^'])*'/g, "''")
        .replace(/--[^\r\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Validates AI-provided SQL for planner-only database access and constructs
 * the EXPLAIN statement itself. The caller must never accept an EXPLAIN prefix.
 */
export function buildSafeExplainSql(sql: string, verbose = false): string {
    const statements = SqlParser.splitStatements(sql)
        .map(statement => statement.trim())
        .filter(statement => statement.length > 0);

    if (statements.length !== 1) {
        throw new Error('AI EXPLAIN accepts exactly one SQL statement.');
    }

    const statement = statements[0];
    const normalized = withoutSqlStringsAndComments(statement).trim();
    if (/^EXPLAIN\b/i.test(normalized)) {
        throw new Error('Provide the SELECT or WITH statement without an EXPLAIN prefix.');
    }
    if (!/^(?:SELECT|WITH)\b/i.test(normalized) || FORBIDDEN_STATEMENT_KEYWORDS.test(normalized)) {
        throw new Error('AI EXPLAIN accepts only a single SELECT or WITH ... SELECT statement.');
    }

    return `EXPLAIN${verbose ? ' VERBOSE' : ''} ${statement}`;
}
