import type {
  CompletionItem,
  CompletionParams,
  Connection,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import type { LspCompletionEngine } from "../completionEngine";
import { runWithRequestBoundary } from "../requestBoundary";

const COMPLETION_REQUEST_BUDGET_MS = 1500;
const COMPLETION_SLOW_LOG_MS = 200;

export interface CompletionHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  completionEngine: LspCompletionEngine;
}

export function registerCompletionHandler(deps: CompletionHandlerDeps): void {
  const { connection, documents, completionEngine } = deps;

  connection.onCompletion(
    async (params: CompletionParams, token): Promise<CompletionItem[]> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return [];
      }

      return runWithRequestBoundary(
        {
          operation: "completion",
          documentUri: document.uri,
          budgetMs: COMPLETION_REQUEST_BUDGET_MS,
          slowLogThresholdMs: COMPLETION_SLOW_LOG_MS,
          fallbackValue: [],
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          if (isCancellationRequested()) {
            return [];
          }

          return completionEngine.provideCompletionItems(
            document,
            params.position,
            params.context?.triggerKind,
          );
        },
      );
    },
  );
}
