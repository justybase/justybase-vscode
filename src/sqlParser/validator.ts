import { Semicolon } from "./lexer";
import {
  parseSqlStatements,
  resolveSqlParsingRuntime,
  type SqlStatementsParseResult,
} from "./parsingRuntime";
import { SqlVisitor } from "./visitor/sqlVisitor";
import { collectSqlSymbolUsagesFromCst } from "./symbols";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";
import type {
  ValidationResult,
  ValidationError,
  TokenPosition,
  TableInfo,
} from "./types";
import type { SchemaProvider } from "./schemaProvider";
import type { DatabaseSqlValidationProfile } from "../sql/authoring/types";
import type { CstNode, IRecognitionException, IToken } from "chevrotain";
import { isIgnorableTrailingDotParserError } from "./parserErrorUtils";
import type {
  DocumentParseRequest,
  DocumentParseSession,
} from "./documentParseSession";
import type { StatementBoundary } from "./statementIndex";
import {
  SCRIPT_SCOPE_CREATE_STATEMENT_PATTERN,
  SCRIPT_SCOPE_DROP_STATEMENT_PATTERN,
} from "./scriptScopeStatements";

interface FriendlyParserError {
  message: string;
  code?: string;
  suggestedFix?: string;
  position?: TokenPosition;
}

interface PreParseCheckResult {
  errors: ValidationError[];
  warnings: ValidationError[];
  duplicateKeywordOffsets: Set<number>;
}

export interface ScopeSeed {
  createdProcedures?: readonly string[];
  createdTables?: readonly TableInfo[];
}

const SCRIPT_SCOPE_DROP_TARGET_PATTERN =
  /\bDROP\s+(?:TABLE|VIEW|PROCEDURE)(?:\s+IF\s+EXISTS)?\s+([A-Za-z0-9_."$]+(?:\.[A-Za-z0-9_."$]+)*(?:\.\.[A-Za-z0-9_."$]+)?)/gi;

function formatRelationName(
  database: string | undefined,
  schema: string | undefined,
  name: string,
): string {
  if (database && schema) {
    return `${database}.${schema}.${name}`;
  }
  if (database && !schema) {
    return `${database}..${name}`;
  }
  if (!database && schema) {
    return `${schema}.${name}`;
  }
  return name;
}

function cloneTableInfo(table: TableInfo): TableInfo {
  return {
    ...table,
    columns: table.columns.map((column) => ({ ...column })),
  };
}

/**
 * Compute Levenshtein edit distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  const dp: number[][] = Array.from({ length: al + 1 }, () => Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[al][bl];
}

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "ON", "AND", "OR", "NOT", "INSERT", "INTO", "UPDATE", "DELETE",
  "CREATE", "DROP", "ALTER", "TABLE", "VIEW", "INDEX", "ORDER", "BY",
  "GROUP", "HAVING", "UNION", "ALL", "DISTINCT", "AS", "SET", "VALUES",
  "NULL", "IN", "BETWEEN", "LIKE", "IS", "EXISTS", "CASE", "WHEN",
  "THEN", "ELSE", "END", "LIMIT", "OFFSET", "FETCH", "FIRST", "ROWS",
  "ONLY", "WITH", "CROSS", "FULL", "NATURAL", "USING",
  "ASC", "DESC", "NULLS", "INTERSECT", "EXCEPT",
  "RECURSIVE", "LATERAL", "DISTRIBUTE", "ORGANIZE", "HASH", "RANDOM",
  "TRUNCATE", "GRANT", "REVOKE", "COMMIT", "ROLLBACK", "BEGIN",
  "EXECUTE", "IMMEDIATE", "RETURN", "RETURNS", "LANGUAGE", "SQL",
  "DECLARE", "CURSOR", "OPEN", "CLOSE", "FETCH", "FOR", "LOOP",
  "WHILE", "REPEAT", "UNTIL", "LEAVE", "ITERATE",
  "RAISE", "NOTICE", "EXCEPTION", "IF", "ELSIF",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK",
  "DEFAULT", "ADD", "COLUMN", "RENAME", "CONSTRAINT",
  "MERGE", "USING", "MATCHED", "NOT", "REPLACE",
  "OVERWRITE", "PARTITION", "CLUSTER", "SORT",
  "COPY", "EXPORT", "IMPORT", "LOAD", "UNLOAD",
  "ANALYZE", "VERBOSE", "EXPLAIN", "DESCRIBE", "SHOW",
  "CALL", "SAVEPOINT", "RELEASE", "LOCK", "UNLOCK",
  "LISTEN", "UNLISTEN", "NOTIFY", "PREPARE", "DEALLOCATE",
  "DISCARD", "RESET", "SET", "SHOW", "CURSOR",
  "MATERIALIZED", "TEMPORARY", "TEMP", "FORCE", "IGNORE",
  "SETOF", "RECORD", "VOID", "TRIGGER", "FUNCTION", "PROCEDURE",
  "RETURNS", "LANGUAGE", "COST", "ROWS", "SUPPORT",
  "STABLE", "VOLATILE", "LEAKPROOF", "CALLED", "INPUT",
  "STRICT", "SECURITY", "DEFINER", "INVOKER",
  "PARALLEL", "UNSAFE", "RESTRICTED", "SAFE",
  "COMMENT", "EXTENSION", "SERVER", "SCHEMA",
  "ROLE", "PUBLICATION", "SUBSCRIPTION",
  "POLICY", "RULE", "SEQUENCE", "TYPE", "DOMAIN",
  "OPERATOR", "AGGREGATE", "FAMILY", "COLLATION",
  "CONVERSION", "TEXT", "SEARCH", "CONFIGURATION",
  "DIRECTORY", "STATISTICS", "MANUAL", "AUTO",
  "IDENTITY", "GENERATED", "ALWAYS", "START", "INCREMENT",
  "CACHE", "CYCLE", "MINVALUE", "MAXVALUE",
  "DEFERRABLE", "INITIALLY", "IMMEDIATE",
  "CASCADE", "RESTRICT", "ACTION",
  "OWNER", "MODE", "VALIDATE", "REINDEX", "REFRESH",
  "CONCURRENTLY", "BUILD", "INCREMENTAL", "COMPACT",
  "ACCESS", "METHOD", "STORAGE", "DISK", "MEMORY",
  "LOGGED", "UNLOGGED",
  "PLAIN", "EXTENDED", "MAIN",
  "SYSTEM", "SESSION", "LOCAL", "CURRENT", "TRANSACTION",
  "ISOLATION", "LEVEL", "SERIALIZABLE", "REPEATABLE", "COMMITTED",
  "UNCOMMITTED", "READ", "WRITE", "ONLY",
  "WORK", "DEFERRABLE",
  "PRIVILEGES", "GRANT", "OPTION",
  "DIAGNOSTICS", "ROW_COUNT", "SQLSTATE", "RESIGNAL",
  "SIGNAL", "OTHERS", "NEW", "OLD",
  "PUBLICATION", "SUBSCRIPTION", "CONNECTION",
  "STATISTICS", "HANDLER", "INLINE", "VALIDATOR",
  "TRANSFORM",
];

export class SqlValidator {
  private visitor: SqlVisitor;
  private schemaProvider?: SchemaProvider;
  private readonly validationProfile: DatabaseSqlValidationProfile;

  constructor(
    schemaProvider?: SchemaProvider,
    validationProfile: DatabaseSqlValidationProfile = getDatabaseSqlAuthoring()
      .validation,
  ) {
    this.schemaProvider = schemaProvider;
    this.validationProfile = validationProfile;
    this.visitor = new SqlVisitor(schemaProvider, validationProfile);
  }

  /**
   * Set or update the schema provider
   */
  setSchemaProvider(provider: SchemaProvider): void {
    this.schemaProvider = provider;
    this.visitor = new SqlVisitor(provider, this.validationProfile);
  }

  private usesBestEffortSyntaxValidation(): boolean {
    return this.validationProfile.syntaxValidationMode === "bestEffort";
  }

  private getParsingRuntime() {
    return resolveSqlParsingRuntime({
      validationProfile: this.validationProfile,
    });
  }

  validate(sql: string): ValidationResult {
    // Treat semicolon-only scripts as valid no-op statements.
    if (/^\s*;+\s*$/.test(sql)) {
      this.visitor = new SqlVisitor(
        this.schemaProvider,
        this.validationProfile,
      );
      return {
        valid: true,
        errors: [],
        warnings: [],
        scope: this.visitor.getScope(),
      };
    }

    const parseResult = parseSqlStatements({
      sql,
      runtime: this.getParsingRuntime(),
      ignoreParserError: isIgnorableTrailingDotParserError,
    });
    return this.validateFromParseResult(sql, parseResult);
  }

  validateWithSession(
    sql: string,
    session: DocumentParseSession,
    request: DocumentParseRequest,
  ): ValidationResult {
    if (/^\s*;+\s*$/.test(sql)) {
      this.visitor = new SqlVisitor(
        this.schemaProvider,
        this.validationProfile,
      );
      return {
        valid: true,
        errors: [],
        warnings: [],
        scope: this.visitor.getScope(),
      };
    }

    session.bindDocumentVersion(
      request.documentUri,
      request.documentVersion,
      sql,
    );
    const parseResult = session.getParseResult({ ...request, sql });
    return this.validateFromParseResult(sql, parseResult);
  }

  async validateWithSessionAsync(
    sql: string,
    session: DocumentParseSession,
    request: DocumentParseRequest,
  ): Promise<ValidationResult> {
    if (/^\s*;+\s*$/.test(sql)) {
      this.visitor = new SqlVisitor(
        this.schemaProvider,
        this.validationProfile,
      );
      return {
        valid: true,
        errors: [],
        warnings: [],
        scope: this.visitor.getScope(),
      };
    }

    session.bindDocumentVersion(
      request.documentUri,
      request.documentVersion,
      sql,
    );
    const parseResult = await session.getParseResultAsync({ ...request, sql });
    return this.validateFromParseResult(sql, parseResult);
  }

  validateFromParseResult(
    sql: string,
    parseResult: SqlStatementsParseResult,
  ): ValidationResult {
    const { lexResult, cst, actionableParserErrors } = parseResult;

    const errors: ValidationError[] = [];
    const preParseWarnings: ValidationError[] = [];
    const symbolWarnings: ValidationError[] = [];
    const useBestEffortSyntaxValidation = this.usesBestEffortSyntaxValidation();

    const preParse = this.runPreParseChecks(lexResult);
    errors.push(...preParse.errors);
    preParseWarnings.push(...preParse.warnings);
    const duplicateKeywordOffsets = preParse.duplicateKeywordOffsets;

    // Step 2: Parse
    // Check for parser errors
    if (actionableParserErrors.length > 0) {
      if (!useBestEffortSyntaxValidation) {
        actionableParserErrors.forEach((error) => {
          errors.push(this.toParserValidationError(lexResult.tokens, error));
        });
      }
    }

    // Step 3: Visit CST and build scope (only if we have a CST and no syntax/lexing errors)
    if (
      cst &&
      lexResult.errors.length === 0 &&
      actionableParserErrors.length === 0
    ) {
      this.visitor.visit(cst);
      symbolWarnings.push(...this.buildUnusedSymbolWarnings(sql, cst));
    } else {
      // Ensure no stale state is returned from a previous validation run.
      this.visitor = new SqlVisitor(
        this.schemaProvider,
        this.validationProfile,
      );
    }

    // Combine all errors
    const visitorErrors = duplicateKeywordOffsets.size > 0
      ? this.visitor.getErrors().filter((e) => {
          if (e.code !== "SQL015") return true;
          return !duplicateKeywordOffsets.has(e.position.offset);
        })
      : this.visitor.getErrors();

    const allErrors = [
      ...errors,
      ...visitorErrors,
      ...preParseWarnings,
      ...symbolWarnings,
    ];

    // Separate errors and warnings
    const validationErrors = allErrors.filter((e) => e.severity === "error");
    const validationWarnings = allErrors.filter(
      (e) =>
        e.severity === "warning" ||
        e.severity === "information" ||
        e.severity === "hint",
    );

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors,
      warnings: validationWarnings,
      scope: this.visitor.getScope(),
    };
  }

  validateStatementFromCst(
    fullSql: string,
    statementCst: CstNode,
    statementOffset: number,
    scopeSeed?: ScopeSeed,
  ): ValidationError[] {
    const range = this.getCstTextRange(statementCst);
    const startOffset = range?.startOffset ?? statementOffset;
    const endOffset = range?.endOffset ?? statementOffset;
    const statementSql = fullSql.substring(startOffset, endOffset + 1).trim();
    return this.validateStatementText(
      fullSql,
      statementSql,
      startOffset,
      scopeSeed,
    );
  }

  validateStatementText(
    fullSql: string,
    statementSql: string,
    statementOffset: number,
    scopeSeed?: ScopeSeed,
  ): ValidationError[] {
    if (!statementSql.trim()) {
      return [];
    }

    const statementValidator = new SqlValidator(
      this.schemaProvider,
      this.validationProfile,
    );
    statementValidator.applyScopeSeed(scopeSeed);
    const result = statementValidator.validate(statementSql);
    return [...result.errors, ...result.warnings].map((issue) =>
      this.remapStatementIssue(fullSql, issue, statementOffset),
    );
  }

  validateIncrementalFromStatements(
    fullSql: string,
    statements: readonly StatementBoundary[],
    dirtyIndices: readonly number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
  ): ValidationResult {
    // Fast path: nothing changed since the last pass. Reuse cached diagnostics
    // and skip both the per-statement re-parse (buildScopeSeeds) and the
    // per-statement visitor walk (validateStatementText).
    if (dirtyIndices.length === 0) {
      const diagnostics: ValidationError[] = [];
      for (const statement of statements) {
        diagnostics.push(...(cachedDiagnostics.get(statement.index) ?? []));
      }
      return this.resultFromDiagnostics(diagnostics);
    }

    const dirty = new Set(dirtyIndices);
    const scopeSeeds = this.buildScopeSeeds(statements);
    const diagnostics: ValidationError[] = [];

    for (const statement of statements) {
      if (dirty.has(statement.index)) {
        diagnostics.push(
          ...this.validateStatementText(
            fullSql,
            statement.sql,
            statement.startOffset,
            scopeSeeds.get(statement.index),
          ),
        );
        continue;
      }

      diagnostics.push(...(cachedDiagnostics.get(statement.index) ?? []));
    }

    return this.resultFromDiagnostics(diagnostics);
  }

  private applyScopeSeed(scopeSeed?: ScopeSeed): void {
    if (!scopeSeed) {
      return;
    }

    this.visitor.seedScriptCreatedProcedures(
      scopeSeed.createdProcedures ?? [],
    );
    this.visitor.seedScriptCreatedTables(scopeSeed.createdTables ?? []);
  }

  private buildScopeSeeds(
    statements: readonly StatementBoundary[],
  ): Map<number, ScopeSeed> {
    const seeds = new Map<number, ScopeSeed>();
    let currentSeed: ScopeSeed = {
      createdProcedures: [],
      createdTables: [],
    };

    for (const statement of statements) {
      seeds.set(statement.index, {
        createdProcedures: [...(currentSeed.createdProcedures ?? [])],
        createdTables: (currentSeed.createdTables ?? []).map(cloneTableInfo),
      });
      currentSeed = this.extendScopeSeedFromStatement(
        currentSeed,
        statement.sql,
      );
    }

    return seeds;
  }

  private extendScopeSeedFromStatement(
    currentSeed: ScopeSeed,
    statementSql: string,
  ): ScopeSeed {
    if (SCRIPT_SCOPE_DROP_STATEMENT_PATTERN.test(statementSql)) {
      return this.removeDroppedRelationsFromSeed(currentSeed, statementSql);
    }

    if (!SCRIPT_SCOPE_CREATE_STATEMENT_PATTERN.test(statementSql)) {
      return currentSeed;
    }

    const parseResult = parseSqlStatements({
      sql: statementSql,
      runtime: this.getParsingRuntime(),
      ignoreParserError: isIgnorableTrailingDotParserError,
    });

    if (
      !parseResult.cst ||
      parseResult.lexResult.errors.length > 0 ||
      parseResult.actionableParserErrors.length > 0
    ) {
      return currentSeed;
    }

    const visitor = new SqlVisitor(
      this.schemaProvider,
      this.validationProfile,
    );
    this.applyScopeSeedToVisitor(visitor, currentSeed);
    visitor.visit(parseResult.cst);

    return {
      createdProcedures: visitor.getScriptCreatedProcedureNames(),
      createdTables: visitor.getScriptScopeTables().map(cloneTableInfo),
    };
  }

  private applyScopeSeedToVisitor(
    visitor: SqlVisitor,
    scopeSeed: ScopeSeed,
  ): void {
    visitor.seedScriptCreatedProcedures(scopeSeed.createdProcedures ?? []);
    visitor.seedScriptCreatedTables(scopeSeed.createdTables ?? []);
  }

  private removeDroppedRelationsFromSeed(
    currentSeed: ScopeSeed,
    statementSql: string,
  ): ScopeSeed {
    const droppedNames = this.extractDroppedRelationNames(statementSql);
    if (droppedNames.length === 0) {
      return currentSeed;
    }

    const droppedKeys = new Set(
      droppedNames.map((name) => name.toUpperCase()),
    );

    const matchesDrop = (relationName: string, bareName?: string): boolean => {
      const upperRelation = relationName.toUpperCase();
      if (droppedKeys.has(upperRelation)) {
        return true;
      }
      if (bareName && droppedKeys.has(bareName.toUpperCase())) {
        return true;
      }
      return Array.from(droppedKeys).some((dropped) => {
        const segments = dropped.split(".");
        return (
          segments[segments.length - 1] === upperRelation ||
          (bareName !== undefined &&
            segments[segments.length - 1] === bareName.toUpperCase())
        );
      });
    };

    return {
      createdProcedures: (currentSeed.createdProcedures ?? []).filter(
        (procedureName) => !matchesDrop(procedureName),
      ),
      createdTables: (currentSeed.createdTables ?? []).filter(
        (table) =>
          !matchesDrop(
            formatRelationName(table.database, table.schema, table.name),
            table.name,
          ),
      ),
    };
  }

  private extractDroppedRelationNames(statementSql: string): string[] {
    const names: string[] = [];
    const pattern = new RegExp(
      SCRIPT_SCOPE_DROP_TARGET_PATTERN.source,
      SCRIPT_SCOPE_DROP_TARGET_PATTERN.flags,
    );
    let match = pattern.exec(statementSql);
    while (match) {
      const rawName = match[1]?.replace(/"/g, "").trim();
      if (rawName) {
        names.push(rawName);
      }
      match = pattern.exec(statementSql);
    }
    return names;
  }

  validateIncremental(
    sql: string,
    parseResult: SqlStatementsParseResult,
    dirtyIndices: number[],
    cachedDiagnostics: Map<number, ValidationError[]>,
    scopeSeeds: Map<number, ScopeSeed> = new Map(),
  ): ValidationResult {
    const statements = parseResult.cst?.children?.statement as
      | CstNode[]
      | undefined;
    if (
      !statements ||
      parseResult.lexResult.errors.length > 0 ||
      parseResult.actionableParserErrors.length > 0
    ) {
      return this.validateFromParseResult(sql, parseResult);
    }

    const dirty = new Set(dirtyIndices);
    const diagnostics: ValidationError[] = [];

    statements.forEach((statementCst, index) => {
      if (dirty.has(index)) {
        diagnostics.push(
          ...this.validateStatementFromCst(
            sql,
            statementCst,
            this.getCstTextRange(statementCst)?.startOffset ?? 0,
            scopeSeeds.get(index),
          ),
        );
        return;
      }

      diagnostics.push(...(cachedDiagnostics.get(index) ?? []));
    });

    return this.resultFromDiagnostics(diagnostics);
  }

  runPreParseChecks(
    lexResult: SqlStatementsParseResult["lexResult"],
  ): PreParseCheckResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];
    const duplicateKeywordOffsets = new Set<number>();

    if (lexResult.errors.length > 0) {
      lexResult.errors.forEach((error) => {
        errors.push({
          message: `Lexer error: ${error.message}`,
          severity: "error",
          position: {
            startLine: error.line || 1,
            startColumn: error.column || 1,
            endLine: error.line || 1,
            endColumn: (error.column || 1) + (error.length || 1),
            offset: error.offset || 0,
          },
          code: "LEX001",
        });
      });
    }

    const hasNonSemicolonToken = lexResult.tokens.some(
      (token) => token.tokenType !== Semicolon,
    );
    if (hasNonSemicolonToken) {
      const semicolonRuns: Array<{ start: number; end: number }> = [];
      let runStart = -1;
      for (let i = 0; i < lexResult.tokens.length; i += 1) {
        const token = lexResult.tokens[i];
        if (token.tokenType === Semicolon) {
          if (runStart === -1) {
            runStart = i;
          }
        } else if (runStart !== -1) {
          semicolonRuns.push({ start: runStart, end: i - 1 });
          runStart = -1;
        }
      }
      if (runStart !== -1) {
        semicolonRuns.push({
          start: runStart,
          end: lexResult.tokens.length - 1,
        });
      }

      const offendingRuns = semicolonRuns.filter((run) => {
        const runLength = run.end - run.start + 1;
        const isLeading = run.start === 0;
        return isLeading ? runLength > 0 : runLength > 1;
      });

      const emptyStatementCount = semicolonRuns.reduce((acc, run) => {
        const runLength = run.end - run.start + 1;
        if (run.start === 0) {
          return acc + runLength;
        }
        return acc + Math.max(0, runLength - 1);
      }, 0);

      if (offendingRuns.length > 0 && emptyStatementCount > 0) {
        const firstRun = offendingRuns[0];
        const lastRun = offendingRuns[offendingRuns.length - 1];
        const first = lexResult.tokens[firstRun.start];
        const last = lexResult.tokens[lastRun.end];
        warnings.push({
          message: `Empty statement(s) detected: ${emptyStatementCount} extra semicolon separator(s)`,
          severity: "warning",
          position: {
            startLine: first.startLine || 1,
            startColumn: first.startColumn || 1,
            endLine: last.endLine || last.startLine || 1,
            endColumn: last.endColumn || last.startColumn || 1,
            offset: first.startOffset || 0,
          },
          code: "PARW001",
        });
      }
    }

    const duplicateClauseKeywords = new Set([
      "From",
      "Where",
      "Join",
      "On",
      "Select",
      "Insert",
      "Update",
      "Delete",
      "Create",
      "Drop",
      "Alter",
      "With",
      "GroupBy",
      "OrderBy",
      "Having",
      "Limit",
      "Offset",
      "Union",
      "Intersect",
      "Except",
      "MinusSet",
    ]);
    for (let i = 1; i < lexResult.tokens.length; i += 1) {
      const prev = lexResult.tokens[i - 1];
      const curr = lexResult.tokens[i];
      if (
        prev.tokenType.name === curr.tokenType.name &&
        duplicateClauseKeywords.has(curr.tokenType.name)
      ) {
        const startOffset = curr.startOffset ?? 0;
        const imageLen = curr.image?.length ?? 1;
        const startCol = curr.startColumn ?? 1;
        const startLn = curr.startLine ?? 1;
        errors.push({
          message: `Duplicate '${curr.image.toUpperCase()}' keyword detected. Remove the extra keyword.`,
          severity: "error",
          position: {
            startLine: startLn,
            startColumn: startCol,
            endLine: startLn,
            endColumn: startCol + imageLen,
            offset: startOffset,
          },
          code: "PAR003",
        });
        duplicateKeywordOffsets.add(startOffset);
      }
    }

    errors.push(...this.detectKeywordTyposInTokens(lexResult.tokens));

    return {
      errors,
      warnings,
      duplicateKeywordOffsets,
    };
  }

  private resultFromDiagnostics(diagnostics: ValidationError[]): ValidationResult {
    this.visitor = new SqlVisitor(
      this.schemaProvider,
      this.validationProfile,
    );
    const validationErrors = diagnostics.filter(
      (issue) => issue.severity === "error",
    );
    const validationWarnings = diagnostics.filter(
      (issue) =>
        issue.severity === "warning" ||
        issue.severity === "information" ||
        issue.severity === "hint",
    );

    return {
      valid: validationErrors.length === 0,
      errors: validationErrors,
      warnings: validationWarnings,
      scope: this.visitor.getScope(),
    };
  }

  private getCstTextRange(
    node: CstNode,
  ): { startOffset: number; endOffset: number } | undefined {
    let startOffset = Number.POSITIVE_INFINITY;
    let endOffset = -1;

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") {
        return;
      }
      if ("image" in value && "tokenType" in value) {
        const token = value as IToken;
        if (token.startOffset !== undefined) {
          startOffset = Math.min(startOffset, token.startOffset);
        }
        if (token.endOffset !== undefined) {
          endOffset = Math.max(endOffset, token.endOffset);
        }
        return;
      }
      if ("children" in value) {
        const childNode = value as CstNode;
        Object.values(childNode.children).forEach(visit);
      }
    };

    visit(node);
    if (!Number.isFinite(startOffset) || endOffset < startOffset) {
      return undefined;
    }
    return { startOffset, endOffset };
  }

  private remapStatementIssue(
    fullSql: string,
    issue: ValidationError,
    statementOffset: number,
  ): ValidationError {
    const absoluteStart = statementOffset + issue.position.offset;
    let absoluteEnd = this.absoluteOffsetFromStatementLineColumn(
      fullSql,
      statementOffset,
      issue.position.endLine,
      issue.position.endColumn,
    );
    if (absoluteEnd <= absoluteStart) {
      absoluteEnd =
        absoluteStart +
        Math.max(1, issue.position.endColumn - issue.position.startColumn);
    }

    return {
      ...issue,
      position: this.offsetRangeToPosition(
        fullSql,
        absoluteStart,
        absoluteEnd,
      ),
    };
  }

  private absoluteOffsetFromStatementLineColumn(
    fullSql: string,
    statementOffset: number,
    line: number,
    column: number,
  ): number {
    let currentLine = 1;
    let index = statementOffset;
    while (index < fullSql.length && currentLine < line) {
      if (fullSql[index] === "\n") {
        currentLine += 1;
      }
      index += 1;
    }
    const lineStart = index;
    return Math.min(fullSql.length, lineStart + Math.max(0, column - 1));
  }

  private toParserValidationError(
    tokens: IToken[],
    error: IRecognitionException,
  ): ValidationError {
    const token = error.token;
    const friendlyError = this.getFriendlyParserError(tokens, error);

    return {
      message: friendlyError?.message ?? `Parser error: ${error.message}`,
      severity: "error",
      position:
        friendlyError?.position ?? this.tokenToPosition(token),
      code: friendlyError?.code ?? "PAR001",
      suggestedFix: friendlyError?.suggestedFix,
    };
  }

  private positionAfterToken(token: IToken): TokenPosition {
    const startLine = token.endLine ?? token.startLine ?? 1;
    const startColumn =
      token.endColumn ??
      (token.startColumn ?? 1) + (token.image?.length ?? 1);
    return {
      startLine,
      startColumn,
      endLine: startLine,
      endColumn: startColumn + 1,
      offset:
        token.endOffset ??
        (token.startOffset ?? 0) + (token.image?.length ?? 0),
    };
  }

  private tokenToPosition(token: IToken): TokenPosition {
    return {
      startLine: token.startLine || 1,
      startColumn: token.startColumn || 1,
      endLine: token.endLine || token.startLine || 1,
      endColumn:
        token.endColumn ||
        (token.startColumn || 1) + (token.image?.length || 1),
      offset: token.startOffset || 0,
    };
  }

  private getFriendlyParserError(
    tokens: IToken[],
    error: IRecognitionException,
  ): FriendlyParserError | undefined {
    const token = error.token;
    const tokenIndex = this.findTokenIndex(tokens, token);
    const previousToken = this.getPreviousToken(tokens, tokenIndex, error);

    return (
      this.detectMissingAsInCte(tokens, tokenIndex) ??
      this.detectDoubleComma(token, previousToken) ??
      this.detectUnclosedCaseExpression(tokens, tokenIndex, error.message) ??
      this.detectTrailingCommaBeforeClause(token, previousToken) ??
      this.detectMissingSelectList(token, previousToken) ??
      this.detectMissingTableSource(token, previousToken) ??
      this.detectMissingClosingParenthesis(token, error.message)
    );
  }

  private detectMissingAsInCte(
    tokens: IToken[],
    tokenIndex: number,
  ): FriendlyParserError | undefined {
    if (tokenIndex < 0) {
      return undefined;
    }

    for (let lParenIndex = tokenIndex - 1; lParenIndex >= 2; lParenIndex--) {
      const lParenToken = tokens[lParenIndex];
      if (lParenToken.tokenType.name !== "LParen") {
        continue;
      }

      const cteNameToken = tokens[lParenIndex - 1];
      const cteLeadToken = tokens[lParenIndex - 2];
      const firstInnerToken = tokens[lParenIndex + 1];

      if (!cteNameToken || !cteLeadToken || !firstInnerToken) {
        continue;
      }

      if (!this.isIdentifierTokenName(cteNameToken.tokenType.name)) {
        continue;
      }

      if (!this.isCteLeadTokenName(cteLeadToken.tokenType.name)) {
        continue;
      }

      if (!this.isCteQueryStartTokenName(firstInnerToken.tokenType.name)) {
        continue;
      }

      if (!this.hasWithKeywordBefore(tokens, lParenIndex - 2)) {
        continue;
      }

      const cteName = this.normalizeIdentifierToken(cteNameToken);
      return {
        code: "PAR101",
        message: `CTE '${cteName}' is missing AS before the subquery. Use '${cteName} AS (...)'.`,
        position: this.tokenToPosition(cteNameToken),
      };
    }

    return undefined;
  }

  private detectDoubleComma(
    token: IToken,
    previousToken: IToken | undefined,
  ): FriendlyParserError | undefined {
    if (
      !previousToken ||
      previousToken.tokenType.name !== "Comma" ||
      token.tokenType.name !== "Comma"
    ) {
      return undefined;
    }

    return {
      code: "PAR002",
      message:
        "Consecutive commas (,,) indicate a missing expression or an extra comma. Remove the extra comma.",
    };
  }

  private detectUnclosedCaseExpression(
    tokens: IToken[],
    tokenIndex: number,
    parserMessage: string,
  ): FriendlyParserError | undefined {
    if (!parserMessage.includes("End")) {
      return undefined;
    }

    const scanEnd = tokenIndex >= 0 ? tokenIndex : tokens.length;
    const openCases: IToken[] = [];

    for (let index = 0; index < scanEnd; index++) {
      const current = tokens[index];
      const tokenName = current.tokenType.name;
      if (tokenName === "Case") {
        openCases.push(current);
        continue;
      }

      if (tokenName !== "End") {
        continue;
      }

      const nextName = tokens[index + 1]?.tokenType.name;
      if (
        nextName === "If" ||
        nextName === "Loop" ||
        nextName === "Proc" ||
        nextName === "Transaction" ||
        nextName === "Work"
      ) {
        continue;
      }

      openCases.pop();
      if (nextName === "Case") {
        index += 1;
      }
    }

    const caseToken = openCases[openCases.length - 1];
    if (!caseToken) {
      return undefined;
    }

    const isProcedure = tokens
      .slice(0, scanEnd)
      .some((candidate) =>
        ["BeginProc", "Nzplsql", "Procedure"].includes(
          candidate.tokenType.name,
        ),
      );

    return {
      code: isProcedure ? "SQL041" : "PAR005",
      message: "CASE expression must end with END.",
      position: this.tokenToPosition(caseToken),
    };
  }

  private detectTrailingCommaBeforeClause(
    token: IToken,
    previousToken: IToken | undefined,
  ): FriendlyParserError | undefined {
    if (!previousToken || previousToken.tokenType.name !== "Comma") {
      return undefined;
    }

    if (!this.isClauseBoundaryTokenName(token.tokenType.name)) {
      return undefined;
    }

    const boundary = this.tokenDisplayName(token);
    return {
      message: `Trailing comma before '${boundary}'. Remove the comma or add another expression.`,
    };
  }

  private detectMissingSelectList(
    token: IToken,
    previousToken: IToken | undefined,
  ): FriendlyParserError | undefined {
    if (token.tokenType.name !== "From" || !previousToken) {
      return undefined;
    }

    const previousName = previousToken.tokenType.name;
    if (
      previousName !== "Select" &&
      previousName !== "Distinct" &&
      previousName !== "All" &&
      previousName !== "Comma"
    ) {
      return undefined;
    }

    return {
      message:
        "SELECT list is empty. Add at least one column or expression before FROM.",
      position: this.positionAfterToken(previousToken),
    };
  }

  private detectMissingTableSource(
    token: IToken,
    previousToken: IToken | undefined,
  ): FriendlyParserError | undefined {
    if (!previousToken) {
      return undefined;
    }

    const previousName = previousToken.tokenType.name;
    if (previousName !== "From" && previousName !== "Join") {
      return undefined;
    }

    if (!this.isMissingTableBoundaryTokenName(token.tokenType.name)) {
      return undefined;
    }

    const keyword = previousToken.image.toUpperCase();
    return {
      message: `Missing table or subquery after ${keyword}. Add an object name (e.g. JUST_DATA..DIMACCOUNT) or a parenthesized subquery with alias.`,
      position: this.positionAfterToken(previousToken),
    };
  }

  private detectMissingClosingParenthesis(
    token: IToken,
    parserMessage: string,
  ): FriendlyParserError | undefined {
    if (!parserMessage.includes("RParen")) {
      return undefined;
    }

    if (
      token.tokenType.name !== "Semicolon" &&
      token.tokenType.name !== "EOF"
    ) {
      return undefined;
    }

    const boundary = this.tokenDisplayName(token);
    return {
      message: `Missing closing ')' before '${boundary}'.`,
    };
  }

  private detectKeywordTyposInTokens(
    tokens: IToken[],
  ): ValidationError[] {
    const results: ValidationError[] = [];
    // Common known typos for high-frequency keywords (missing letters, transpositions)
    const COMMON_TYPOS: Record<string, string> = {
      "FRM": "FROM",
      "FOM": "FROM",
      "FRO": "FROM",
      "FORM": "FROM",
      "OFRM": "FROM",
      "FRXM": "FROM",
      "SELEC": "SELECT",
      "SELCT": "SELECT",
      "SELET": "SELECT",
      "SELKT": "SELECT",
      "SELCET": "SELECT",
      "SLEECT": "SELECT",
      "SELELCT": "SELECT",
      "SELEECT": "SELECT",
    };

    // Only the most common clause keywords — avoid false positives on column/table names
    const CLAUSE_KEYWORDS = [
      "SELECT", "FROM", "WHERE", "JOIN", "INSERT", "UPDATE", "DELETE",
      "CREATE", "DROP", "ALTER", "TABLE", "ORDER", "GROUP",
      "HAVING", "UNION", "LIMIT", "OFFSET",
    ];

    for (const token of tokens) {
      if (token.tokenType.name !== "Identifier" && token.tokenType.name !== "Word") {
        continue;
      }

      const image = token.image;
      if (!image || image.length < 3) continue;

      const upper = image.toUpperCase();
      if (SQL_KEYWORDS.includes(upper)) continue;

      // Check common typos dictionary first (catches transpositions, multi-char errors)
      const dictFix = COMMON_TYPOS[upper];
      if (dictFix) {
        const startOffset = token.startOffset ?? 0;
        const imageLen = token.image?.length ?? 1;
        const startCol = (token.startColumn ?? 1);
        const startLn = (token.startLine ?? 1);
        results.push({
          message: `Possible typo: '${image}' looks like keyword '${dictFix}'. Did you mean '${dictFix}'?`,
          severity: "error",
          position: {
            startLine: startLn,
            startColumn: startCol,
            endLine: startLn,
            endColumn: startCol + imageLen,
            offset: startOffset,
          },
          code: "PAR004",
          suggestedFix: dictFix,
        });
        continue;
      }

      if (image.length < 4) continue;

      for (const kw of CLAUSE_KEYWORDS) {
        if (levenshtein(upper, kw) === 1 && image.length <= kw.length) {
          const startOffset = token.startOffset ?? 0;
          const imageLen = token.image?.length ?? 1;
          const startCol = (token.startColumn ?? 1);
          const startLn = (token.startLine ?? 1);
          results.push({
            message: `Possible typo: '${image}' looks like keyword '${kw}'. Did you mean '${kw}'?`,
            severity: "error",
            position: {
              startLine: startLn,
              startColumn: startCol,
              endLine: startLn,
              endColumn: startCol + imageLen,
              offset: startOffset,
            },
            code: "PAR004",
            suggestedFix: kw,
          });
          break;
        }
      }
    }

    return results;
  }

  private findTokenIndex(tokens: IToken[], token: IToken): number {
    const directIndex = tokens.indexOf(token);
    if (directIndex >= 0) {
      return directIndex;
    }

    const tokenStartOffset = token.startOffset;
    if (tokenStartOffset === undefined) {
      return -1;
    }

    return tokens.findIndex(
      (candidate) =>
        candidate.startOffset === tokenStartOffset &&
        candidate.image === token.image &&
        candidate.tokenType.name === token.tokenType.name,
    );
  }

  private getPreviousToken(
    tokens: IToken[],
    tokenIndex: number,
    error: IRecognitionException,
  ): IToken | undefined {
    if (tokenIndex > 0) {
      return tokens[tokenIndex - 1];
    }

    const parserError = error as IRecognitionException & {
      previousToken?: IToken;
    };
    return parserError.previousToken;
  }

  private isIdentifierTokenName(tokenName: string): boolean {
    return tokenName === "Identifier" || tokenName === "QuotedIdentifier";
  }

  private isCteLeadTokenName(tokenName: string): boolean {
    return (
      tokenName === "With" || tokenName === "Recursive" || tokenName === "Comma"
    );
  }

  private isCteQueryStartTokenName(tokenName: string): boolean {
    return (
      tokenName === "Select" ||
      tokenName === "With" ||
      tokenName === "Insert" ||
      tokenName === "Update" ||
      tokenName === "Delete"
    );
  }

  private hasWithKeywordBefore(tokens: IToken[], startIndex: number): boolean {
    for (let index = startIndex; index >= 0; index--) {
      const tokenName = tokens[index].tokenType.name;
      if (tokenName === "With") {
        return true;
      }
      if (tokenName === "Semicolon") {
        return false;
      }
    }
    return false;
  }

  private isClauseBoundaryTokenName(tokenName: string): boolean {
    return (
      tokenName === "From" ||
      tokenName === "Where" ||
      tokenName === "GroupBy" ||
      tokenName === "Having" ||
      tokenName === "OrderBy" ||
      tokenName === "Limit" ||
      tokenName === "Fetch" ||
      tokenName === "Union" ||
      tokenName === "Intersect" ||
      tokenName === "Except" ||
      tokenName === "MinusSet" ||
      tokenName === "RParen" ||
      tokenName === "Semicolon"
    );
  }

  private isMissingTableBoundaryTokenName(tokenName: string): boolean {
    return (
      tokenName === "Where" ||
      tokenName === "GroupBy" ||
      tokenName === "Having" ||
      tokenName === "OrderBy" ||
      tokenName === "Limit" ||
      tokenName === "Fetch" ||
      tokenName === "Union" ||
      tokenName === "Intersect" ||
      tokenName === "Except" ||
      tokenName === "MinusSet" ||
      tokenName === "On" ||
      tokenName === "RParen" ||
      tokenName === "Semicolon" ||
      tokenName === "EOF"
    );
  }

  private normalizeIdentifierToken(token: IToken): string {
    return token.image.replace(/^"|"$/g, "");
  }

  private tokenDisplayName(token: IToken): string {
    if (token.tokenType.name === "Semicolon") {
      return ";";
    }
    if (token.tokenType.name === "EOF") {
      return "end of statement";
    }
    return token.image;
  }

  private buildUnusedSymbolWarnings(
    sql: string,
    cst: CstNode,
  ): ValidationError[] {
    const symbolUsages = collectSqlSymbolUsagesFromCst(cst);
    const warnings: ValidationError[] = [];

    for (const symbol of symbolUsages) {
      const definition = symbol.occurrences.find(
        (occurrence) => occurrence.role === "definition",
      );
      if (!definition) {
        continue;
      }

      const referenceCount = symbol.occurrences.filter(
        (occurrence) => occurrence.role === "reference",
      ).length;
      if (referenceCount > 0) {
        continue;
      }

      if (symbol.kind === "cte") {
        warnings.push({
          message: `CTE '${symbol.name}' is defined but never used`,
          severity: "warning",
          position: this.offsetRangeToPosition(
            sql,
            definition.startOffset,
            definition.endOffset,
          ),
          code: "SQL018",
        });
        continue;
      }

      if (symbol.kind === "table_alias") {
        warnings.push({
          message: `Table alias '${symbol.name}' is defined but never used`,
          severity: "warning",
          position: this.offsetRangeToPosition(
            sql,
            definition.startOffset,
            definition.endOffset,
          ),
          code: "SQL019",
        });
      }
    }

    return warnings;
  }

  private offsetRangeToPosition(
    sql: string,
    startOffset: number,
    endOffset: number,
  ): TokenPosition {
    const safeStart = Math.max(0, Math.min(startOffset, sql.length));
    const safeEnd = Math.max(safeStart, Math.min(endOffset, sql.length));
    const start = this.offsetToLineColumn(sql, safeStart);
    const endIndex = safeEnd > safeStart ? safeEnd - 1 : safeStart;
    const end = this.offsetToLineColumn(sql, endIndex);

    return {
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column + 1,
      offset: safeStart,
    };
  }

  private offsetToLineColumn(
    sql: string,
    offset: number,
  ): { line: number; column: number } {
    const safeOffset = Math.max(0, Math.min(offset, sql.length));
    let line = 1;
    let column = 1;

    for (let index = 0; index < safeOffset; index++) {
      if (sql[index] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
    }

    return { line, column };
  }

  /**
   * Quick validation that only checks syntax without full scope analysis
   */
  quickValidate(sql: string): boolean {
    if (/^\s*;+\s*$/.test(sql)) {
      return true;
    }

    const parsingRuntime = this.getParsingRuntime();
    const parseResult = parseSqlStatements({
      sql,
      runtime: parsingRuntime,
    });

    if (parseResult.lexResult.errors.length > 0) {
      return false;
    }

    if (this.usesBestEffortSyntaxValidation()) {
      return true;
    }

    return !!parseResult.cst && parseResult.actionableParserErrors.length === 0;
  }
}

// Export singleton instance
export const sqlValidator = new SqlValidator();

// Export types
export * from "./types";
