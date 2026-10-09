import {
  type Connection,
  Definition,
  Location,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import {
  buildSqlColumnRenameEdits,
  buildSqlRenameEdits,
  type DocumentParseSession,
} from "../../sqlParser";
import {
  SqlColumnIdentityAnalysis,
  type SqlColumnCatalogLookup,
  type SqlColumnCatalogTable,
  type SqlColumnIdentity,
} from "@justybase/sql-core/validation/columnIdentity";
import {
  prepareSqlColumnRename,
  resolveSqlColumnCatalogTarget,
  type SqlColumnCatalogTarget,
} from "@justybase/sql-core/validation/columnAuthoring";
import {
  NETEZZA_COLUMN_CATALOG_TARGET_REQUEST,
  type ColumnCatalogTargetParams,
  type MetadataContextResponse,
} from "../../lsp/protocol";
import type { MetadataBridge } from "../metadataBridge";
import { runWithRequestBoundary } from "../requestBoundary";
import { resolveSqlRenameSymbolFromSession } from "../parseSessionUtils";
import { offsetRangeToRange } from "./hoverHandler";

const DEFINITION_REQUEST_BUDGET_MS = 1000;
const REFERENCES_REQUEST_BUDGET_MS = 1000;
const RENAME_REQUEST_BUDGET_MS = 1000;
const DEFINITION_SLOW_LOG_MS = 150;
const REFERENCES_SLOW_LOG_MS = 150;
const RENAME_SLOW_LOG_MS = 150;

/** Upper bound on tables whose metadata one column navigation request may load. */
const COLUMN_IDENTITY_MAX_TABLES = 32;

export interface ColumnIdentityWithMetadata {
  analysis: SqlColumnIdentityAnalysis;
  /** Metadata of the referenced tables, for re-analysis of edited text. */
  lookup: SqlColumnCatalogLookup;
}

/**
 * Column identities of the document for Definition, References, Hover,
 * Rename and catalog targets. Only tables referenced by the document are
 * looked up, through the bridge's per-connection cache, never the whole
 * catalog. The analysis is request-local and is discarded with the request.
 */
export async function analyzeColumnIdentitiesWithMetadata(
  document: TextDocument,
  metadataBridge: Pick<MetadataBridge, "getTableInfo">,
  context: Pick<MetadataContextResponse, "databaseKind" | "effectiveDatabase">,
  isCancellationRequested: () => boolean = () => false,
): Promise<ColumnIdentityWithMetadata | undefined> {
  if (context.databaseKind && context.databaseKind !== "netezza") {
    return undefined;
  }
  const sql = document.getText();
  const structure = SqlColumnIdentityAnalysis.analyze(sql);
  if (!structure) {
    return undefined;
  }
  const keyOf = (database: string | undefined, schema: string | undefined, table: string) =>
    [database ?? "", schema ?? "", table].map((part) => part.toUpperCase()).join("|");
  const tables = new Map<string, { database?: string; schema?: string; name: string }>();
  for (const reference of structure.physicalTables) {
    if (tables.size >= COLUMN_IDENTITY_MAX_TABLES) break;
    tables.set(keyOf(reference.database, reference.schema, reference.name), reference);
  }
  const fetched = new Map<string, SqlColumnCatalogTable>();
  await Promise.all(
    Array.from(tables.entries()).map(async ([key, reference]) => {
      const database = reference.database ?? context.effectiveDatabase;
      if (!database) return;
      const info = await metadataBridge.getTableInfo(document.uri, database, reference.name, reference.schema);
      if (!info?.exists) return;
      fetched.set(key, {
        database: info.database ?? database,
        schema: info.schema ?? reference.schema ?? null,
        name: info.table || reference.name,
        columns: info.columns.map((column) => column.name),
        columnTypes: info.columns.map((column) => column.type || undefined),
      });
    }),
  );
  if (isCancellationRequested()) {
    return undefined;
  }
  const lookup: SqlColumnCatalogLookup = (database, schema, table) => fetched.get(keyOf(database, schema, table));
  // Resolve again with metadata, reusing the parse that found the tables.
  const analysis = fetched.size > 0 ? SqlColumnIdentityAnalysis.analyze(sql, lookup, structure.parseResult) : structure;
  return analysis ? { analysis, lookup } : undefined;
}

/** Resolves the column at `offset`; see {@link analyzeColumnIdentitiesWithMetadata}. */
export async function resolveColumnIdentityWithMetadata(
  document: TextDocument,
  offset: number,
  metadataBridge: Pick<MetadataBridge, "getTableInfo">,
  context: Pick<MetadataContextResponse, "databaseKind" | "effectiveDatabase">,
  isCancellationRequested: () => boolean = () => false,
): Promise<SqlColumnIdentity | undefined> {
  const columns = await analyzeColumnIdentitiesWithMetadata(document, metadataBridge, context, isCancellationRequested);
  return columns?.analysis.identityAt(offset);
}

/**
 * The catalog column a host can reveal in its schema browser for the column
 * at `offset`; physical navigation never invents a document range.
 */
export async function resolveColumnCatalogTargetWithMetadata(
  document: TextDocument,
  offset: number,
  metadataBridge: Pick<MetadataBridge, "getTableInfo">,
  context: Pick<MetadataContextResponse, "databaseKind" | "effectiveDatabase">,
  isCancellationRequested: () => boolean = () => false,
): Promise<SqlColumnCatalogTarget | undefined> {
  const identity = await resolveColumnIdentityWithMetadata(document, offset, metadataBridge, context, isCancellationRequested);
  return resolveSqlColumnCatalogTarget(identity);
}

export interface SymbolHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  metadataBridge: MetadataBridge;
  documentParseSession: DocumentParseSession;
}

export function registerSymbolHandlers(deps: SymbolHandlerDeps): void {
  const { connection, documents, metadataBridge, documentParseSession } = deps;

  connection.onDefinition(async (params, token): Promise<Definition | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return null;
    }

    return runWithRequestBoundary(
      {
        operation: "definition",
        documentUri: document.uri,
        budgetMs: DEFINITION_REQUEST_BUDGET_MS,
        slowLogThresholdMs: DEFINITION_SLOW_LOG_MS,
        fallbackValue: null,
        logger: connection.console,
        token,
      },
      async ({ isCancellationRequested }) => {
        if (isCancellationRequested()) {
          return null;
        }

        const offset = document.offsetAt(params.position);
        const context = await metadataBridge.getContext(document.uri);
        if (isCancellationRequested()) {
          return null;
        }

        const symbol = resolveSqlRenameSymbolFromSession(
          documentParseSession,
          document,
          offset,
          context.databaseKind,
        );
        if (symbol) {
          const definitionOccurrence =
            symbol.occurrences.find(
              (occurrence) => occurrence.role === "definition",
            ) ?? symbol.target;
          const range = offsetRangeToRange(
            document,
            definitionOccurrence.startOffset,
            definitionOccurrence.endOffset,
          );
          return Location.create(document.uri, range);
        }

        // Columns: a local projection navigates to its definition; a physical
        // column has no location in the document.
        const column = await resolveColumnIdentityWithMetadata(
          document,
          offset,
          metadataBridge,
          context,
          isCancellationRequested,
        );
        if (column?.definition) {
          return Location.create(
            document.uri,
            offsetRangeToRange(document, column.definition.startOffset, column.definition.endOffset),
          );
        }
        return null;
      },
    );
  });

  connection.onReferences(async (params, token): Promise<Location[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return null;
    }

    return runWithRequestBoundary(
      {
        operation: "references",
        documentUri: document.uri,
        budgetMs: REFERENCES_REQUEST_BUDGET_MS,
        slowLogThresholdMs: REFERENCES_SLOW_LOG_MS,
        fallbackValue: null,
        logger: connection.console,
        token,
      },
      async ({ isCancellationRequested }) => {
        if (isCancellationRequested()) {
          return null;
        }

        const offset = document.offsetAt(params.position);
        const context = await metadataBridge.getContext(document.uri);
        if (isCancellationRequested()) {
          return null;
        }

        const symbol = resolveSqlRenameSymbolFromSession(
          documentParseSession,
          document,
          offset,
          context.databaseKind,
        );
        if (!symbol) {
          const column = await resolveColumnIdentityWithMetadata(
            document,
            offset,
            metadataBridge,
            context,
            isCancellationRequested,
          );
          if (!column || column.status !== "resolved") {
            return null;
          }
          return column.occurrences
            .filter((occurrence) => params.context.includeDeclaration || !occurrence.isDefinition)
            .map((occurrence) =>
              Location.create(
                document.uri,
                offsetRangeToRange(document, occurrence.startOffset, occurrence.endOffset),
              ),
            );
        }

        const occurrences = params.context.includeDeclaration
          ? symbol.occurrences
          : symbol.occurrences.filter(
              (occurrence) => occurrence.role !== "definition",
            );

        return occurrences.map((occurrence) =>
          Location.create(
            document.uri,
            offsetRangeToRange(
              document,
              occurrence.startOffset,
              occurrence.endOffset,
            ),
          ),
        );
      },
    );
  });

  connection.onPrepareRename(async (params, token) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return null;
    }

    return runWithRequestBoundary(
      {
        operation: "prepareRename",
        documentUri: document.uri,
        budgetMs: RENAME_REQUEST_BUDGET_MS,
        slowLogThresholdMs: RENAME_SLOW_LOG_MS,
        fallbackValue: null,
        logger: connection.console,
        token,
      },
      async ({ isCancellationRequested }) => {
        if (isCancellationRequested()) {
          return null;
        }

        const offset = document.offsetAt(params.position);
        const context = await metadataBridge.getContext(document.uri);
        if (isCancellationRequested()) {
          return null;
        }

        const symbol = resolveSqlRenameSymbolFromSession(
          documentParseSession,
          document,
          offset,
          context.databaseKind,
        );
        if (!symbol) {
          // Local columns only: physical catalog columns are never renamed.
          const columns = await analyzeColumnIdentitiesWithMetadata(
            document,
            metadataBridge,
            context,
            isCancellationRequested,
          );
          const target = columns && prepareSqlColumnRename(columns.analysis, document.getText(), offset);
          if (!target || isCancellationRequested()) {
            return null;
          }
          return {
            range: offsetRangeToRange(document, target.startOffset, target.endOffset),
            placeholder: target.identity.name,
          };
        }

        return {
          range: offsetRangeToRange(
            document,
            symbol.target.startOffset,
            symbol.target.endOffset,
          ),
          placeholder: symbol.name,
        };
      },
    );
  });

  connection.onRenameRequest(
    async (params, token): Promise<WorkspaceEdit | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      return runWithRequestBoundary(
        {
          operation: "rename",
          documentUri: document.uri,
          budgetMs: RENAME_REQUEST_BUDGET_MS,
          slowLogThresholdMs: RENAME_SLOW_LOG_MS,
          fallbackValue: null,
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          if (isCancellationRequested()) {
            return null;
          }

          const trimmedName = params.newName.trim();
          if (!trimmedName) {
            return null;
          }

          const offset = document.offsetAt(params.position);
          const context = await metadataBridge.getContext(document.uri);
          if (isCancellationRequested()) {
            return null;
          }

          const symbol = resolveSqlRenameSymbolFromSession(
            documentParseSession,
            document,
            offset,
            context.databaseKind,
          );
          if (!symbol) {
            const columns = await analyzeColumnIdentitiesWithMetadata(
              document,
              metadataBridge,
              context,
              isCancellationRequested,
            );
            const columnEdits = columns && buildSqlColumnRenameEdits(document.getText(), offset, trimmedName, columns.lookup);
            if (!columnEdits || isCancellationRequested()) return null;
            return {
              changes: {
                [document.uri]: columnEdits.map((edit) => ({
                  range: offsetRangeToRange(document, edit.startOffset, edit.endOffset),
                  newText: edit.newText,
                })),
              },
            };
          }

          const edits = buildSqlRenameEdits(document.getText(), symbol, trimmedName);
          if (!edits || isCancellationRequested()) return null;
          return {
            changes: {
              [document.uri]: edits.map((occurrence) => ({
                range: offsetRangeToRange(
                  document,
                  occurrence.startOffset,
                  occurrence.endOffset,
                ),
                newText: occurrence.newText,
              })),
            },
          };
        },
      );
    },
  );

  connection.onRequest(
    NETEZZA_COLUMN_CATALOG_TARGET_REQUEST,
    async (params: ColumnCatalogTargetParams, token): Promise<SqlColumnCatalogTarget | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }
      return runWithRequestBoundary(
        {
          operation: "columnCatalogTarget",
          documentUri: document.uri,
          budgetMs: DEFINITION_REQUEST_BUDGET_MS,
          slowLogThresholdMs: DEFINITION_SLOW_LOG_MS,
          fallbackValue: null,
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          const context = await metadataBridge.getContext(document.uri);
          if (isCancellationRequested()) {
            return null;
          }
          const target = await resolveColumnCatalogTargetWithMetadata(
            document,
            document.offsetAt(params.position),
            metadataBridge,
            context,
            isCancellationRequested,
          );
          return target ?? null;
        },
      );
    },
  );
}
