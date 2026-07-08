import type { Connection } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import type { LspInlayHintEngine } from "../inlayHintEngine";
import { runWithRequestBoundary } from "../requestBoundary";

const INLAY_HINT_REQUEST_BUDGET_MS = 6000;
const INLAY_HINT_SLOW_LOG_MS = 150;

export interface InlayHintHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  inlayHintEngine: LspInlayHintEngine;
}

export function registerInlayHintHandler(deps: InlayHintHandlerDeps): void {
  const { connection, documents, inlayHintEngine } = deps;

  connection.languages.inlayHint.on(async (params, token) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return [];
    }

    return runWithRequestBoundary(
      {
        operation: "inlayHint",
        documentUri: document.uri,
        budgetMs: INLAY_HINT_REQUEST_BUDGET_MS,
        slowLogThresholdMs: INLAY_HINT_SLOW_LOG_MS,
        fallbackValue: [],
        logger: connection.console,
        token,
      },
      async ({ isCancellationRequested }) => {
        if (isCancellationRequested()) {
          return [];
        }

        const enabled = await shouldShowInlineTypeHints(connection, document.uri);
        if (!enabled || isCancellationRequested()) {
          return [];
        }

        return inlayHintEngine.provideInlayHints(
          document,
          params.range,
          isCancellationRequested,
        );
      },
    );
  });
}

export function requestInlayHintRefresh(connection: Connection): void {
  void connection.languages.inlayHint.refresh().catch(() => undefined);
}

async function shouldShowInlineTypeHints(
  connection: Connection,
  documentUri: string,
): Promise<boolean> {
  try {
    const [currentSetting, legacySetting] =
      await connection.workspace.getConfiguration([
        {
          scopeUri: documentUri,
          section: "justybase.sql.showInlineTypeHints",
        },
        {
          scopeUri: documentUri,
          section: "netezza.sql.showInlineTypeHints",
        },
      ]);

    if (typeof currentSetting === "boolean") {
      return currentSetting;
    }
    if (typeof legacySetting === "boolean") {
      return legacySetting;
    }
  } catch (error: unknown) {
    connection.console.error(
      `Failed to read inline hint configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return true;
}
