import {
  type Connection,
  Definition,
  Location,
  WorkspaceEdit,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import {
  formatSqlRenameReplacement,
  type DocumentParseSession,
} from "../../sqlParser";
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
          return null;
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
          return null;
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
            return null;
          }

          return {
            changes: {
              [document.uri]: symbol.occurrences.map((occurrence) => ({
                range: offsetRangeToRange(
                  document,
                  occurrence.startOffset,
                  occurrence.endOffset,
                ),
                newText: formatSqlRenameReplacement(
                  occurrence.text,
                  trimmedName,
                ),
              })),
            },
          };
        },
      );
    },
  );
}
