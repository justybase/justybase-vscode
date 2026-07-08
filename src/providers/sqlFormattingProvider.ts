import * as vscode from "vscode";
import { formatSql, type SqlFormatterOptions } from "../services/sqlFormatter";
import type { ConnectionManager } from "../core/connectionManager";

export class SqlFormattingProvider
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider
{
  constructor(private readonly connectionManager?: ConnectionManager) {}

  public provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    return this.formatDocument(document, options);
  }

  public provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    _token: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    return this.formatDocument(document, options, range);
  }

  private formatDocument(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    range?: vscode.Range,
  ): vscode.TextEdit[] {
    const config = vscode.workspace.getConfiguration("justybase");
    const tabWidth = config.get<number>("formatSQL.tabWidth", options.tabSize);
    const keywordCase = config.get<"upper" | "lower" | "preserve">(
      "formatSQL.keywordCase",
      "upper",
    );

    const text = range ? document.getText(range) : document.getText();
    const documentUri = document.uri.toString();
    const databaseKind =
      this.connectionManager?.getExecutionDatabaseKind(documentUri);

    const formatterOptions: SqlFormatterOptions = {
      tabWidth,
      keywordCase,
      linesBetweenQueries: 2,
      databaseKind,
    };

    try {
      const result = formatSql(text, formatterOptions);
      const targetRange =
        range ??
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        );
      return [vscode.TextEdit.replace(targetRange, result)];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(
        `SQL formatting failed: ${message}`,
      );
      return [];
    }
  }
}
