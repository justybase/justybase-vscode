import { SqlParser } from '../../sql/sqlParser';

/**
 * SQL access classification shared by the Copilot tools and the MCP server.
 *
 * Classification is intentionally conservative: anything the parser cannot
 * prove to be a plain read is treated as a write, and DDL/DCL statements are
 * destructive. The database permissions of the connection remain the real
 * boundary; this layer decides which tool tier may run the statement.
 */

const FORBIDDEN_STATEMENT_KEYWORDS =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|EXEC(?:UTE)?|COPY|GRANT|REVOKE|INTO)\b/iu;
const LOCKING_CLAUSE = /\bFOR\s+(?:(?:NO\s+)?KEY\s+)?(?:UPDATE|SHARE)\b/iu;
const DESTRUCTIVE_STATEMENT = /^(?:DROP|TRUNCATE|GRANT|REVOKE)\b/iu;
const WRITE_STATEMENT =
  /^(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|COMMENT|COPY|CALL|EXEC(?:UTE)?|VACUUM|GROOM|GENSTATS|SET|RESET|BEGIN|COMMIT|ROLLBACK)\b/iu;

export type SqlAccessKind = 'read' | 'write' | 'destructive';

export interface SqlAccessClassification {
  readonly kind: SqlAccessKind;
  /** The single statement, trimmed, without a trailing semicolon. */
  readonly statement: string;
  readonly reason: string;
}

function withoutSqlStringsAndComments(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/gu, "''")
    .replace(/--[^\r\n]*/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '');
}

/** Splits and rejects scripts: every execution tool accepts exactly one statement. */
export function splitSingleStatement(sql: string): string {
  const statements = SqlParser.splitStatements(sql)
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);

  if (statements.length !== 1) {
    throw new Error('AI EXPLAIN accepts exactly one SQL statement.');
  }
  return statements[0]!.replace(/;\s*$/u, '').trim();
}

/**
 * Validates AI-provided SQL for planner-only database access and constructs
 * the EXPLAIN statement itself. The caller must never accept an EXPLAIN prefix.
 */
export function buildSafeExplainSql(sql: string, verbose = false): string {
  const statement = splitSingleStatement(sql);
  const normalized = withoutSqlStringsAndComments(statement).trim();
  if (/^EXPLAIN\b/iu.test(normalized)) {
    throw new Error('Provide the SELECT or WITH statement without an EXPLAIN prefix.');
  }
  // `SELECT ... INTO` materializes a table and locking clauses acquire row
  // locks, so neither is planner-only. Reject them alongside DML/DDL.
  if (!/^(?:SELECT|WITH)\b/iu.test(normalized)
    || FORBIDDEN_STATEMENT_KEYWORDS.test(normalized)
    || LOCKING_CLAUSE.test(normalized)) {
    throw new Error('AI EXPLAIN accepts only a single SELECT or WITH ... SELECT statement.');
  }

  return `EXPLAIN${verbose ? ' VERBOSE' : ''} ${statement}`;
}

export function classifySqlStatement(sql: string): SqlAccessClassification {
  // NZPLSQL bodies contain semicolons, so the generic statement splitter must
  // not run before the procedure block has been handed to the server.
  if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b[\s\S]*\bEND_PROC\s*;?\s*$/iu.test(sql)) {
    return {
      kind: 'write',
      statement: sql.trim().replace(/;\s*$/u, ''),
      reason: 'NZPLSQL procedure block.',
    };
  }

  const statement = splitSingleStatement(sql);
  const normalized = withoutSqlStringsAndComments(statement).trim();

  if (DESTRUCTIVE_STATEMENT.test(normalized)
    || (/\bALTER\b/iu.test(normalized) && /\bDROP\b/iu.test(normalized))) {
    return {
      kind: 'destructive',
      statement,
      reason: 'The statement drops or revokes a database object or privilege.',
    };
  }

  if (/^(?:SELECT|WITH|EXPLAIN)\b/iu.test(normalized)) {
    if (/\bINTO\b/iu.test(normalized)) {
      return {
        kind: 'write',
        statement,
        reason: 'SELECT ... INTO materializes a table.',
      };
    }
    if (LOCKING_CLAUSE.test(normalized)) {
      return {
        kind: 'write',
        statement,
        reason: 'The statement acquires row locks (FOR UPDATE/SHARE).',
      };
    }
    if (FORBIDDEN_STATEMENT_KEYWORDS.test(normalized)) {
      return {
        kind: 'write',
        statement,
        reason: 'The statement contains data-changing SQL inside a query expression.',
      };
    }
    return { kind: 'read', statement, reason: 'Planner-only or read-only query.' };
  }

  if (WRITE_STATEMENT.test(normalized)) {
    return { kind: 'write', statement, reason: 'The statement changes database state.' };
  }

  // Unknown statements fail closed: they need the write tier.
  return {
    kind: 'write',
    statement,
    reason: 'The statement kind could not be proven read-only, so it requires the write tier.',
  };
}

export function isDestructiveStatement(sql: string): boolean {
  return classifySqlStatement(sql).kind === 'destructive';
}

const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED_IDENTIFIER = String.raw`${IDENTIFIER}(?:\.${IDENTIFIER})*`;
const DESTRUCTIVE_TARGET = new RegExp(
  String.raw`^(?:DROP\s+(?:TABLE|VIEW|PROCEDURE|EXTERNAL\s+TABLE|SYNONYM|NICKNAME|ALIAS)\s+(?:IF\s+EXISTS\s+)?|TRUNCATE\s+(?:TABLE\s+)?)(${QUALIFIED_IDENTIFIER})`,
  'iu',
);

/**
 * Returns the short object name a DROP/TRUNCATE confirmation must repeat.
 * The confirmation is a speed bump, not a security boundary.
 */
export function destructiveTarget(statement: string): string | undefined {
  const match = DESTRUCTIVE_TARGET.exec(statement);
  const raw = match?.[1]?.split('.').filter(part => part.length > 0).pop();
  return raw?.replace(/^"|"$/gu, '').replace(/""/gu, '"');
}
