/**
 * SQL Validation Commands - commands for validating SQL using Chevrotain parser
 */

import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import type { MetadataCache } from "../metadataCache";
import type { ConnectionManager } from "../core/connectionManager";
import { isSqlAuthoringLanguageId } from "../utils/sqlLanguage";
import { isLspDiagnosticsSkipExceeded } from "../sqlParser/validationConfig";
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

function reportValidationSummary(
  errorCount: number,
  warningCount: number,
  scope: "document" | "selection",
): void {
  if (errorCount === 0 && warningCount === 0) {
    const message =
      scope === "selection"
        ? "Selection validation passed! No errors or warnings found."
        : "SQL validation passed! No errors or warnings found.";
    vscode.window.showInformationMessage(message);
    return;
  }

  const message =
    `SQL validation found ${errorCount} error(s) and ${warningCount} warning(s).`
    + " Check the Problems panel for details.";
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
  const result = validator.validate(sql);
  const { getSqlLinter } = await import("../providers/sqlLinterProvider");
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

            if (lspAutomaticallySkips) {
              progress.report({
                message:
                  "Large script: automatic LSP diagnostics were skipped; running a full parse.",
              });
            }

            const result = await validateAndPublish(document, sqlToValidate, {
              baseOffset: wholeDocument
                ? 0
                : document.offsetAt(selection.start),
              source: wholeDocument
                ? PARSER_SOURCE_DOCUMENT
                : PARSER_SOURCE_SELECTION,
            });

            reportValidationSummary(
              result.errors.length,
              result.warnings.length,
              wholeDocument ? "document" : "selection",
            );

            getLogger().info(
              `SQL validation completed: ${result.errors.length + result.warnings.length} issues found`
              + ` (${wholeDocument ? "document" : "selection"}, ${sqlToValidate.length} chars)`,
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
