import {
  type Connection,
  type Hover,
  type HoverParams,
  Range,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import type { DocumentParseSession } from "../../sqlParser";
import { SqlParser } from "../../sql/sqlParser";
import type { AliasInfo, LocalDefinition } from "../../providers/types";
import { provideHover, type HoverDependencies } from "../hoverEngine";
import type { MetadataBridge } from "../metadataBridge";
import { toDocumentParseRequest } from "../documentParseRequest";
import { runWithRequestBoundary } from "../requestBoundary";
import { resolveSqlRenameSymbolFromSession } from "../parseSessionUtils";

const HOVER_REQUEST_BUDGET_MS = 1000;
const HOVER_SLOW_LOG_MS = 150;

export interface HoverHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  metadataBridge: MetadataBridge;
  documentParseSession: DocumentParseSession;
}

export function registerHoverHandler(deps: HoverHandlerDeps): void {
  const { connection, documents, metadataBridge, documentParseSession } = deps;

  connection.onHover(async (params: HoverParams, token): Promise<Hover | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return null;
    }

    const hoverDeps: HoverDependencies = {
      resolveSqlRenameSymbol: (_sql, offset, databaseKind) =>
        resolveSqlRenameSymbolFromSession(
          documentParseSession,
          document,
          offset,
          databaseKind,
        ),
      getStatementAtPosition: (sql, offset) =>
        SqlParser.getStatementAtPosition(sql, offset, {
          documentId: document.uri,
          version: document.version,
        }),
      getAliasBindings: (statementSql, statementOffset, databaseKind) =>
        getSessionAliasBindings(
          documentParseSession,
          document,
          statementSql,
          statementOffset,
          databaseKind,
        ),
      getCompletionLocalDefinitions: (
        fullSql,
        statementSql,
        statementOffset,
        databaseKind,
      ) =>
        getSessionCompletionLocalDefinitions(
          documentParseSession,
          document,
          fullSql,
          statementSql,
          statementOffset,
          databaseKind,
        ),
      findLocalDefinition,
      formatObjectPath,
      isCancellationRequested: () => token.isCancellationRequested,
    };

    if (token.isCancellationRequested) {
      return null;
    }

    return runWithRequestBoundary(
      {
        operation: "hover",
        documentUri: document.uri,
        budgetMs: HOVER_REQUEST_BUDGET_MS,
        slowLogThresholdMs: HOVER_SLOW_LOG_MS,
        fallbackValue: null,
        logger: connection.console,
        token,
      },
      async () => provideHover(document, params, hoverDeps, metadataBridge),
    );
  });
}

function getSessionAliasBindings(
  documentParseSession: DocumentParseSession,
  document: TextDocument,
  statementSql: string,
  statementOffset: number,
  databaseKind?: string,
): Map<string, AliasInfo> {
  try {
    return documentParseSession.getSemanticScope({
      ...toDocumentParseRequest(document, statementSql, databaseKind),
      cursorOffset: statementOffset,
    }).preferredAliasBindings;
  } catch {
    return new Map<string, AliasInfo>();
  }
}

function getSessionCompletionLocalDefinitions(
  documentParseSession: DocumentParseSession,
  document: TextDocument,
  fullSql: string,
  statementSql: string,
  statementOffset: number,
  databaseKind?: string,
): LocalDefinition[] {
  const persistentDefs = getSessionPersistentDocumentDefinitions(
    documentParseSession,
    document,
    fullSql,
    databaseKind,
  );
  const visibleDefs = getSessionVisibleStatementDefinitions(
    documentParseSession,
    document,
    statementSql,
    statementOffset,
    databaseKind,
  );
  return mergeLocalDefinitions(persistentDefs, visibleDefs);
}

function getSessionVisibleStatementDefinitions(
  documentParseSession: DocumentParseSession,
  document: TextDocument,
  statementSql: string,
  statementOffset: number,
  databaseKind?: string,
): LocalDefinition[] {
  try {
    return documentParseSession.getSemanticScope({
      ...toDocumentParseRequest(document, statementSql, databaseKind),
      cursorOffset: statementOffset,
    }).visibleLocalDefinitions;
  } catch {
    return [];
  }
}

function getSessionPersistentDocumentDefinitions(
  documentParseSession: DocumentParseSession,
  document: TextDocument,
  sql: string,
  databaseKind?: string,
): LocalDefinition[] {
  try {
    return documentParseSession
      .getSemanticScope(toDocumentParseRequest(document, sql, databaseKind))
      .localDefinitions.filter((def) => {
        const normalizedType = def.type.toUpperCase();
        return normalizedType === "TABLE" || normalizedType === "TEMP TABLE";
      });
  } catch {
    return [];
  }
}

function mergeLocalDefinitions(
  base: LocalDefinition[],
  current: LocalDefinition[],
): LocalDefinition[] {
  const merged = new Map<string, LocalDefinition>();
  for (const def of base) {
    merged.set(def.name.toUpperCase(), def);
  }
  for (const def of current) {
    merged.set(def.name.toUpperCase(), def);
  }
  return Array.from(merged.values());
}

function findLocalDefinition(
  localDefinitions: LocalDefinition[],
  name: string,
): LocalDefinition | undefined {
  const normalizedName = name.toUpperCase();
  return localDefinitions.find(
    (def) => def.name.toUpperCase() === normalizedName,
  );
}

export function formatObjectPath(
  database: string | undefined,
  schema: string | undefined,
  table: string,
): string {
  if (database && schema) {
    return `${database}.${schema}.${table}`;
  }
  if (database) {
    return `${database}..${table}`;
  }
  if (schema) {
    return `${schema}.${table}`;
  }
  return table;
}

export function offsetRangeToRange(
  document: TextDocument,
  startOffset: number,
  endOffset: number,
): Range {
  const safeStart = Math.max(0, startOffset);
  const safeEnd = Math.max(safeStart + 1, endOffset);
  return Range.create(
    document.positionAt(safeStart),
    document.positionAt(safeEnd),
  );
}
