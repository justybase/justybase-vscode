import type { DatabaseKind } from "../../contracts/database";
import { SqlParser } from "../../sql/sqlParser";
import type { DocumentParseSession } from "../../sqlParser/documentParseSession";
import type { SqlStatementsParseResult } from "../../sqlParser/parsingRuntime";
import { isPersistentDocumentDefinition } from "../../server/completionLocalDefinitionUtils";
import {
  buildSemanticScopeFromParseResult,
  parseLocalDefinitionsWithParser,
  parseSemanticScopeWithParser,
  type ParserSemanticScope,
} from "./parserSqlContext";

export interface SqlLocalShadowContextRequest {
  documentUri: string;
  documentVersion: number;
  sql: string;
  databaseKind?: DatabaseKind;
  parseSession?: DocumentParseSession;
  parseResult?: SqlStatementsParseResult;
}

export interface SqlLocalShadowContext {
  persistentLocalNames: ReadonlySet<string>;
  aliasNames: ReadonlySet<string>;
  isShadowedAtOffset(tableName: string, offset: number): boolean;
}

interface StatementBoundary {
  start: number;
  end: number;
  sql: string;
}

/**
 * Shared local-definition shadow index for unqualified catalog object names.
 * One parse per request; CTE visibility is resolved at most once per statement.
 */
export function buildSqlLocalShadowContext(
  request: SqlLocalShadowContextRequest,
): SqlLocalShadowContext {
  const parseResult = resolveParseResult(request);
  const documentScope = resolveDocumentScope(request, parseResult);
  const persistentLocalNames = collectPersistentLocalDefinitionNames(
    documentScope,
    request.sql,
    request.databaseKind,
  );
  const aliasNames = collectDocumentAliasNames(documentScope);
  const statementBoundaries = SqlParser.splitStatementsWithPositions(
    request.sql,
  ).map((statement) => ({
    start: statement.startOffset,
    end: statement.endOffset,
    sql: statement.sql,
  }));
  const statementCteCache = new Map<string, Set<string>>();

  return {
    persistentLocalNames,
    aliasNames,
    isShadowedAtOffset(tableName: string, offset: number): boolean {
      const normalizedName = tableName.toUpperCase();
      if (persistentLocalNames.has(normalizedName)) {
        return true;
      }
      if (aliasNames.has(normalizedName)) {
        return true;
      }
      return getStatementCteNamesAtOffset(
        request,
        offset,
        statementCteCache,
        parseResult,
        statementBoundaries,
      ).has(normalizedName);
    },
  };
}

function resolveParseResult(
  request: SqlLocalShadowContextRequest,
): SqlStatementsParseResult | undefined {
  if (request.parseResult) {
    return request.parseResult;
  }
  if (!request.parseSession) {
    return undefined;
  }

  try {
    return request.parseSession.getParseResult({
      documentUri: request.documentUri,
      documentVersion: request.documentVersion,
      sql: request.sql,
      databaseKind: request.databaseKind,
    });
  } catch {
    return undefined;
  }
}

function resolveDocumentScope(
  request: SqlLocalShadowContextRequest,
  parseResult: SqlStatementsParseResult | undefined,
): ParserSemanticScope | undefined {
  if (parseResult) {
    try {
      return buildSemanticScopeFromParseResult(
        parseResult,
        request.sql,
        undefined,
        request.databaseKind,
      );
    } catch {
      // Fall through to session/direct parse.
    }
  }

  if (request.parseSession) {
    try {
      return request.parseSession.getSemanticScope({
        documentUri: request.documentUri,
        documentVersion: request.documentVersion,
        sql: request.sql,
        databaseKind: request.databaseKind,
      });
    } catch {
      // Fall through to direct parse.
    }
  }

  try {
    return parseSemanticScopeWithParser(
      request.sql,
      undefined,
      request.databaseKind,
    );
  } catch {
    return undefined;
  }
}

function collectPersistentLocalDefinitionNames(
  scope: ParserSemanticScope | undefined,
  sql: string,
  databaseKind?: DatabaseKind,
): Set<string> {
  const localDefinitionNames = new Set<string>();
  const definitions =
    scope?.localDefinitions ??
    (() => {
      try {
        return parseLocalDefinitionsWithParser(sql, databaseKind);
      } catch {
        return [];
      }
    })();

  for (const definition of definitions) {
    if (isPersistentDocumentDefinition(definition)) {
      localDefinitionNames.add(definition.name.toUpperCase());
    }
  }

  return localDefinitionNames;
}

function collectDocumentAliasNames(
  scope: ParserSemanticScope | undefined,
): Set<string> {
  const aliasNames = new Set<string>();
  if (!scope) {
    return aliasNames;
  }

  scope.preferredAliasBindings.forEach((binding, key) => {
    if (binding.table.toUpperCase() !== key.toUpperCase()) {
      aliasNames.add(key.toUpperCase());
    }
  });
  return aliasNames;
}

function findStatementBoundary(
  boundaries: StatementBoundary[],
  offset: number,
): StatementBoundary | undefined {
  return boundaries.find(
    (statement) => offset >= statement.start && offset <= statement.end + 1,
  );
}

function statementMayDefineCte(statementSql: string): boolean {
  return /\bWITH\b/i.test(statementSql);
}

function getStatementCteNamesAtOffset(
  request: SqlLocalShadowContextRequest,
  offset: number,
  cache: Map<string, Set<string>>,
  parseResult: SqlStatementsParseResult | undefined,
  statementBoundaries: StatementBoundary[],
): Set<string> {
  const statement = findStatementBoundary(statementBoundaries, offset);
  if (statement && !statementMayDefineCte(statement.sql)) {
    return new Set<string>();
  }

  const cacheKey = statement
    ? `${statement.start}:${statement.end}:${offset}`
    : String(offset);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const scopeOffset = offset;
  const cteNames = new Set<string>();

  try {
    const visibleScope = parseResult
      ? buildSemanticScopeFromParseResult(
          parseResult,
          request.sql,
          scopeOffset,
          request.databaseKind,
        )
      : request.parseSession
        ? request.parseSession.getSemanticScope({
            documentUri: request.documentUri,
            documentVersion: request.documentVersion,
            sql: request.sql,
            databaseKind: request.databaseKind,
            cursorOffset: scopeOffset,
          })
        : parseSemanticScopeWithParser(
            request.sql,
            scopeOffset,
            request.databaseKind,
          );

    for (const definition of visibleScope.visibleLocalDefinitions) {
      if (definition.type.toUpperCase() === "CTE") {
        cteNames.add(definition.name.toUpperCase());
      }
    }
  } catch {
    // No CTE filtering on parse failure.
  }

  cache.set(cacheKey, cteNames);
  return cteNames;
}
