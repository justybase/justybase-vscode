/**
 * SQL Validation Commands - commands for validating SQL using Chevrotain parser
 */

import * as vscode from "vscode";
import { isSqlLanguageClientRunning } from "../activation/lspRegistration";
import { getLogger } from "../utils/logger";
import type { MetadataCache } from "../metadataCache";
import type { ConnectionManager } from "../core/connectionManager";
import { isSqlAuthoringLanguageId } from "../utils/sqlLanguage";
import {
  isLspDiagnosticsSkipExceeded,
  shouldIncludeParserDiagnosticsInExtensionLint,
} from "../sqlParser/validationConfig";
import type { LintIssue } from "../providers/linterRules";
import {
  createDesktopSqlValidatorForDocument,
  getDesktopSqlAuthoringForDocument,
  getDesktopSqlValidationContext,
  getInitializedDesktopSqlValidator,
  initializeDesktopSqlValidator,
  type SqlValidationContext,
} from "../sqlParser/desktopValidationContext";
import type { SchemaProvider } from "../sqlParser/schemaProvider";
import type { SqlValidationService } from "../sqlParser/validationService";
import type { ValidationResult } from "../sqlParser";

export type { SqlValidationContext } from "../sqlParser/desktopValidationContext";

const PARSER_SOURCE_DOCUMENT = "Netezza Parser (on demand)";
const PARSER_SOURCE_SELECTION = "Netezza Parser (selection)";

/**
 * Initialize the SQL validator with metadata cache for column validation
 */
export function initializeSqlValidator(
  metadataCache: MetadataCache,
  connectionManager: ConnectionManager,
): void {
  initializeDesktopSqlValidator(metadataCache, connectionManager);
  getLogger().info("SQL validator initialized with metadata cache");
}

export function getSqlValidationContext(): SqlValidationContext | undefined {
  return getDesktopSqlValidationContext();
}

export function getSqlAuthoringForDocument(documentUri?: string) {
  return getDesktopSqlAuthoringForDocument(documentUri);
}

export function createSqlValidatorForDocument(
  documentUri?: string,
  schemaProvider?: SchemaProvider,
): SqlValidationService {
  return createDesktopSqlValidatorForDocument(documentUri, schemaProvider);
}

/**
 * Get the initialized SQL validator instance (if available).
 * Used by other components (e.g., linter) to reuse schema-aware validation.
 */
export function getInitializedSqlValidator(
  documentUri?: string,
): SqlValidationService | undefined {
  return getInitializedDesktopSqlValidator(documentUri);
}

function isWholeDocumentSelection(
  document: vscode.TextDocument,
  selection: vscode.Selection,
): boolean {
  const end = document.positionAt(document.getText().length);
  return (
    selection.start.line === 0 &&
    selection.start.character === 0 &&
    selection.end.line === end.line &&
    selection.end.character === end.character
  );
}

function countLintIssuesBySeverity(issues: readonly LintIssue[]): {
  errorCount: number;
  warningCount: number;
} {
  let errorCount = 0;
  let warningCount = 0;
  for (const issue of issues) {
    if (issue.severity === vscode.DiagnosticSeverity.Error) {
      errorCount += 1;
    } else if (issue.severity === vscode.DiagnosticSeverity.Warning) {
      warningCount += 1;
    }
  }
  return { errorCount, warningCount };
}

function reportValidationSummary(
  errorCount: number,
  warningCount: number,
  scope: "document" | "selection",
  lspOwnsParserDiagnostics: boolean,
): void {
  if (errorCount === 0 && warningCount === 0) {
    if (lspOwnsParserDiagnostics) {
      vscode.window.showInformationMessage(
        "No quality-rule issues found. Parser diagnostics (if any) are in the Problems panel (LSP).",
      );
      return;
    }
    const message =
      scope === "selection"
        ? "Selection validation passed! No errors or warnings found."
        : "SQL validation passed! No errors or warnings found.";
    vscode.window.showInformationMessage(message);
    return;
  }

  let message =
    `SQL validation found ${errorCount} error(s) and ${warningCount} warning(s).`
    + " Check the Problems panel for details.";
  if (lspOwnsParserDiagnostics) {
    message += " Parser diagnostics (if any) are in the Problems panel (LSP).";
  }
  if (errorCount > 0) {
    vscode.window.showErrorMessage(message);
  } else {
    vscode.window.showWarningMessage(message);
  }

  void vscode.commands.executeCommand("workbench.actions.view.problems");
}

async function validateAndPublish(
  document: vscode.TextDocument,
  sql: string,
  options: { baseOffset: number; source: string },
): Promise<ValidationResult> {
  const validator = createSqlValidatorForDocument(document.uri.toString());
  const documentVersion = document.version;
  const result = validator.validate(sql);
  const { getSqlLinter } = await import("../providers/sqlLinterProvider");
  if (document.version !== documentVersion) {
    getLogger().warn(
      "SQL validation result discarded because the document changed during validation.",
    );
    return result;
  }
  getSqlLinter().publishValidationErrors(
    document,
    [...result.errors, ...result.warnings],
    {
      baseOffset: options.baseOffset,
      source: options.source,
    },
  );
  return result;
}

/**
 * Register SQL validation commands
 */
export function registerValidationCommands(): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Register validate selected SQL command
  disposables.push(
    vscode.commands.registerCommand("netezza.validateSelectedSql", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor found");
        return;
      }

      const document = editor.document;

      // Only validate SQL files
      if (!isSqlAuthoringLanguageId(document.languageId)) {
        vscode.window.showWarningMessage(
          "This command only works with supported SQL files",
        );
        return;
      }

      const selection = editor.selection;
      const wholeDocument =
        selection.isEmpty || isWholeDocumentSelection(document, selection);
      const sqlToValidate = wholeDocument
        ? document.getText()
        : document.getText(selection);

      if (!sqlToValidate.trim()) {
        vscode.window.showWarningMessage("No SQL code to validate");
        return;
      }

      const lspAutomaticallySkips = isLspDiagnosticsSkipExceeded(
        document.lineCount,
        sqlToValidate.length,
      );
      const lspRunning = isSqlLanguageClientRunning();
      const lspOwnsParserDiagnostics = lspRunning && !lspAutomaticallySkips;
      const linterIncludesParser = shouldIncludeParserDiagnosticsInExtensionLint(
        lspRunning,
        sqlToValidate.length,
      );
      const needsDirectParser =
        !lspOwnsParserDiagnostics && !linterIncludesParser;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: wholeDocument
              ? `Validating SQL with Chevrotain parser (${document.lineCount.toLocaleString()} lines)…`
              : "Validating selected SQL with Chevrotain parser…",
            cancellable: false,
          },
          async (progress) => {
            // Yield once so the progress notification can render before the
            // synchronous parser work starts in the extension host.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));

            if (wholeDocument) {
              const { getSqlLinter } = await import(
                "../providers/sqlLinterProvider"
              );
              const lintIssues = await getSqlLinter().lintDocument(
                document,
                true,
              );
              const counts = countLintIssuesBySeverity(lintIssues);
              let parserIssueCount = 0;

              if (needsDirectParser) {
                progress.report({
                  message: lspRunning
                    ? "Large script: automatic LSP diagnostics were skipped; running a full parse."
                    : "Large script: running parser and quality validation.",
                });
                const result = await validateAndPublish(
                  document,
                  sqlToValidate,
                  {
                    baseOffset: 0,
                    source: PARSER_SOURCE_DOCUMENT,
                  },
                );
                counts.errorCount += result.errors.length;
                counts.warningCount += result.warnings.length;
                parserIssueCount = result.errors.length + result.warnings.length;
              }

              reportValidationSummary(
                counts.errorCount,
                counts.warningCount,
                "document",
                lspOwnsParserDiagnostics,
              );

              getLogger().info(
                `SQL validation completed: ${lintIssues.length + parserIssueCount} issues found`
                + ` (document, ${sqlToValidate.length} chars)`,
              );
              return;
            }

            if (lspAutomaticallySkips) {
              progress.report({
                message:
                  "Large script: automatic LSP diagnostics were skipped; running a full parse.",
              });
            }

            const result = await validateAndPublish(document, sqlToValidate, {
              baseOffset: document.offsetAt(selection.start),
              source: PARSER_SOURCE_SELECTION,
            });

            reportValidationSummary(
              result.errors.length,
              result.warnings.length,
              "selection",
              false,
            );

            getLogger().info(
              `SQL validation completed: ${result.errors.length + result.warnings.length} issues found`
              + ` (selection, ${sqlToValidate.length} chars)`,
            );
          },
        );
      } catch (error) {
        getLogger().error("Error during SQL validation:", error);
        vscode.window.showErrorMessage(`Error validating SQL: ${error}`);
      }
    }),
  );

  // Register clear validation command
  disposables.push(
    vscode.commands.registerCommand(
      "netezza.clearValidationResults",
      async () => {
        const { getSqlLinter } = await import("../providers/sqlLinterProvider");
        const linter = getSqlLinter();
        if (vscode.window.activeTextEditor) {
          linter.clearDiagnostics(vscode.window.activeTextEditor.document.uri);
          vscode.window.showInformationMessage("Validation results cleared");
        } else {
          linter.clearAllDiagnostics();
          vscode.window.showInformationMessage(
            "All validation results cleared",
          );
        }
      },
    ),
  );

  return disposables;
}
