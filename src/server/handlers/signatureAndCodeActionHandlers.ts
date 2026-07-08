import {
  CodeAction,
  CodeActionKind,
  Command,
  type Connection,
  MarkupKind,
  SignatureHelp,
  type SignatureHelpParams,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import type { MetadataBridge } from "../metadataBridge";
import { runWithRequestBoundary } from "../requestBoundary";
import {
  buildTableQualificationCodeActions,
  getDiagnosticSuggestedFix,
} from "../tableQualificationCodeActions";
import {
  findFunctionCall,
  getTextBeforeCursor,
} from "../signatureHelpUtils";

const SIGNATURE_HELP_REQUEST_BUDGET_MS = 1000;
const SIGNATURE_HELP_SLOW_LOG_MS = 150;

export interface SignatureHelpHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  metadataBridge: MetadataBridge;
}

export function registerSignatureHelpHandler(
  deps: SignatureHelpHandlerDeps,
): void {
  const { connection, documents, metadataBridge } = deps;

  connection.onSignatureHelp(
    async (params: SignatureHelpParams, token): Promise<SignatureHelp | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      return runWithRequestBoundary(
        {
          operation: "signatureHelp",
          documentUri: document.uri,
          budgetMs: SIGNATURE_HELP_REQUEST_BUDGET_MS,
          slowLogThresholdMs: SIGNATURE_HELP_SLOW_LOG_MS,
          fallbackValue: null,
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          if (isCancellationRequested()) {
            return null;
          }

          const offset = document.offsetAt(params.position);
          const textBeforeCursor = getTextBeforeCursor(document, offset);

          const functionCall = findFunctionCall(textBeforeCursor);
          if (!functionCall) {
            return null;
          }

          if (isCancellationRequested()) {
            return null;
          }

          const { functionName, argumentPosition } = functionCall;
          const normalizedName = functionName.toUpperCase();

          const context = await metadataBridge.getContext(document.uri);
          if (isCancellationRequested()) {
            return null;
          }

          const signatures =
            getDatabaseSqlAuthoring(context.databaseKind).signatures.get(
              normalizedName,
            );
          if (!signatures || signatures.length === 0) {
            return null;
          }

          return {
            signatures: signatures.map((sig) => ({
              label: `${sig.name}(${sig.parameters.join(", ")})`,
              documentation: {
                kind: MarkupKind.Markdown,
                value: sig.description,
              },
              parameters: sig.parameters.map((param) => ({
                label: param as string,
              })),
            })),
            activeSignature: 0,
            activeParameter: argumentPosition,
          } satisfies SignatureHelp;
        },
      );
    },
  );
}

export interface CodeActionHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  metadataBridge?: MetadataBridge;
}

export function registerCodeActionHandler(deps: CodeActionHandlerDeps): void {
  const { connection, documents, metadataBridge } = deps;

  connection.onCodeAction(
    async (params, token): Promise<(Command | CodeAction)[] | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      return runWithRequestBoundary(
        {
          operation: "codeAction",
          documentUri: document.uri,
          budgetMs: 1000,
          slowLogThresholdMs: 200,
          fallbackValue: null,
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          if (isCancellationRequested()) {
            return null;
          }

          const actions: (Command | CodeAction)[] = [];
          const text = document.getText();

          for (const diagnostic of params.context.diagnostics) {
            const code =
              typeof diagnostic.code === "string"
                ? diagnostic.code
                : String(diagnostic.code ?? "");
            const range = diagnostic.range;

            if (code === "SQL007") {
              const rangeText = text.substring(
                document.offsetAt(range.start),
                document.offsetAt(range.end),
              );
              const suggestedFix = getDiagnosticSuggestedFix(diagnostic);
              actions.push(
                ...(await buildTableQualificationCodeActions(
                  document.uri,
                  diagnostic,
                  range,
                  rangeText,
                  metadataBridge,
                  true,
                )),
              );

              const match = rangeText.match(/^(\w+)\.(\w+)$/);
              if (match) {
                actions.push({
                  title: "Convert to DB..TABLE format (Netezza syntax)",
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: !suggestedFix,
                  edit: {
                    changes: {
                      [document.uri]: [
                        { range, newText: `${match[1]}..${match[2]}` },
                      ],
                    },
                  },
                } satisfies CodeAction);
              }
            }

            if (code === "SQL048") {
              const rangeText = text.substring(
                document.offsetAt(range.start),
                document.offsetAt(range.end),
              );
              actions.push(
                ...(await buildTableQualificationCodeActions(
                  document.uri,
                  diagnostic,
                  range,
                  rangeText,
                  metadataBridge,
                  true,
                )),
              );
            }

            if (code === "SQL012") {
              const insertPos = {
                line: range.end.line,
                character: range.end.character,
              };
              actions.push({
                title: "Add VARCHAR length (e.g., VARCHAR(100))",
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                  changes: {
                    [document.uri]: [
                      {
                        range: { start: insertPos, end: insertPos },
                        newText: "(100)",
                      },
                    ],
                  },
                },
              } satisfies CodeAction);
            }

            if (code === "SQL019") {
              actions.push({
                title: "Remove unused alias",
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                  changes: {
                    [document.uri]: [{ range, newText: "" }],
                  },
                },
              } satisfies CodeAction);
            }

            if (code === "PAR003") {
              actions.push({
                title: "Remove duplicate keyword",
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                  changes: {
                    [document.uri]: [{ range, newText: "" }],
                  },
                },
              } satisfies CodeAction);
            }

            if (code === "PAR004") {
              const fix = getDiagnosticSuggestedFix(diagnostic);
              if (fix) {
                actions.push({
                  title: `Fix typo: ${fix}`,
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: true,
                  edit: {
                    changes: {
                      [document.uri]: [{ range, newText: fix }],
                    },
                  },
                } satisfies CodeAction);
              }
            }

            if (isCancellationRequested()) {
              return null;
            }
          }

          return actions.length > 0 ? actions : null;
        },
      );
    },
  );
}
