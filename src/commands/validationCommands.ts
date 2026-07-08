/**
 * SQL Validation Commands - commands for validating SQL using Chevrotain parser
 */

import * as vscode from "vscode";
import { isSqlLanguageClientRunning } from "../activation/lspRegistration";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";
import { SqlValidator } from "../sqlParser";
import { createMetadataCacheSchemaProvider } from "../sqlParser/metadataCacheAdapter";
import { getLogger } from "../utils/logger";
import type { MetadataCache } from "../metadataCache";
import type { ConnectionManager } from "../core/connectionManager";
import type { SchemaProvider } from "../sqlParser/schemaProvider";
import { isSqlAuthoringLanguageId } from "../utils/sqlLanguage";
import type { LintIssue } from "../providers/linterRules";

interface SqlValidationContext {
  metadataCache: MetadataCache;
  connectionManager: ConnectionManager;
}

// Global validator instance (will be initialized with dependencies)
let validatorInstance: SqlValidator | undefined;
let validationContext: SqlValidationContext | undefined;

/**
 * Initialize the SQL validator with metadata cache for column validation
 */
export function initializeSqlValidator(
  metadataCache: MetadataCache,
  connectionManager: ConnectionManager,
): void {
  validationContext = { metadataCache, connectionManager };
  validatorInstance = createSqlValidatorForDocument();
  getLogger().info("SQL validator initialized with metadata cache");
}

export function getSqlValidationContext(): SqlValidationContext | undefined {
  return validationContext;
}

export function getSqlAuthoringForDocument(documentUri?: string) {
  const databaseKind =
    validationContext?.connectionManager?.getExecutionDatabaseKind?.(
      documentUri,
    );
  return getDatabaseSqlAuthoring(databaseKind);
}

export function createSqlValidatorForDocument(
  documentUri?: string,
  schemaProvider?: SchemaProvider,
): SqlValidator {
  const authoring = getSqlAuthoringForDocument(documentUri);

  if (schemaProvider) {
    return new SqlValidator(schemaProvider, authoring.validation);
  }

  if (!validationContext) {
    return new SqlValidator(undefined, authoring.validation);
  }

  const connectionName =
    validationContext.connectionManager.resolveConnectionName?.(documentUri);
  if (!connectionName) {
    return new SqlValidator(undefined, authoring.validation);
  }

  const resolvedSchemaProvider = createMetadataCacheSchemaProvider(
    validationContext.metadataCache,
    validationContext.connectionManager,
    connectionName,
    documentUri,
  );

  return new SqlValidator(resolvedSchemaProvider, authoring.validation);
}

/**
 * Get the initialized SQL validator instance (if available).
 * Used by other components (e.g., linter) to reuse schema-aware validation.
 */
export function getInitializedSqlValidator(
  documentUri?: string,
): SqlValidator | undefined {
  if (documentUri && validationContext) {
    return createSqlValidatorForDocument(documentUri);
  }

  return validatorInstance;
}

function countLintIssuesBySeverity(issues: LintIssue[]): {
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

function reportWholeDocumentValidationSummary(
  issues: LintIssue[],
  lspOwnsParserDiagnostics: boolean,
): void {
  const { errorCount, warningCount } = countLintIssuesBySeverity(issues);

  if (errorCount === 0 && warningCount === 0) {
    const message = lspOwnsParserDiagnostics
      ? "No quality-rule issues found. Parser diagnostics (if any) are in the Problems panel (LSP)."
      : "SQL validation passed! No errors or warnings found.";
    vscode.window.showInformationMessage(message);
    return;
  }

  let message = `SQL validation found ${errorCount} error(s) and ${warningCount} warning(s).`;
  if (lspOwnsParserDiagnostics) {
    message +=
      " Quality-rule issues are listed above; parser diagnostics (if any) are in the Problems panel (LSP).";
  } else {
    message += " Check the Problems panel for details.";
  }

  if (errorCount > 0) {
    vscode.window.showErrorMessage(message);
  } else {
    vscode.window.showWarningMessage(message);
  }

  void vscode.commands.executeCommand("workbench.actions.view.problems");
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
      let sqlToValidate: string;

      if (selection.isEmpty) {
        // If no selection, validate entire document via the linter (on-demand mode)
        sqlToValidate = document.getText();
      } else {
        // Validate selected text
        sqlToValidate = document.getText(selection);
      }

      if (!sqlToValidate.trim()) {
        vscode.window.showWarningMessage("No SQL code to validate");
        return;
      }

      try {
        if (selection.isEmpty) {
          const { getSqlLinter } =
            await import("../providers/sqlLinterProvider");
          const linter = getSqlLinter();
          const qualityIssues = await linter.lintDocument(document, true);
          reportWholeDocumentValidationSummary(
            qualityIssues,
            isSqlLanguageClientRunning(),
          );
          getLogger().info(
            `SQL validation completed: ${qualityIssues.length} quality issues found`,
          );
          return;
        } else {
          // Selection-only validation: just report the count (positions
          // would be relative to the selection, not the document).
          const validator = createSqlValidatorForDocument(
            document.uri.toString(),
          );
          const result = validator.validate(sqlToValidate);
          const allIssues = [...result.errors, ...result.warnings];

          if (allIssues.length === 0) {
            vscode.window.showInformationMessage(
              "SQL validation passed! No errors or warnings found.",
            );
          } else {
            const errorCount = result.errors.length;
            const warningCount = result.warnings.length;
            const message = `SQL validation found ${errorCount} error(s) and ${warningCount} warning(s).`;
            if (errorCount > 0) {
              vscode.window.showErrorMessage(message);
            } else {
              vscode.window.showWarningMessage(message);
            }
          }
          getLogger().info(
            `SQL validation (selection) completed: ${allIssues.length} issues found`,
          );
          return;
        }
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
