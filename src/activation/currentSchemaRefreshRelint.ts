import * as vscode from "vscode";
import type { ConnectionManager } from "../core/connectionManager";
import { isSqlAuthoringLanguageId } from "../utils/sqlLanguage";
import { notifyDocumentContextChanged } from "./lspRegistration";

export async function relintDocumentsAfterCurrentSchemaRefresh(
  connectionManager: ConnectionManager,
  connectionName: string,
  database: string,
): Promise<void> {
  const normalizedDatabase = database.toUpperCase();
  const { getSqlLinter } = await import("../providers/sqlLinterProvider");

  for (const document of vscode.workspace.textDocuments) {
    if (!isSqlAuthoringLanguageId(document.languageId)) {
      continue;
    }

    const documentUri = document.uri.toString();
    const documentConnection =
      connectionManager.getConnectionForExecution(documentUri)
      || connectionManager.getActiveConnectionName();
    if (documentConnection !== connectionName) {
      continue;
    }

    const effectiveDatabase = await connectionManager.getEffectiveDatabase(
      documentUri,
    );
    if (effectiveDatabase?.toUpperCase() !== normalizedDatabase) {
      continue;
    }

    notifyDocumentContextChanged(documentUri);
    void getSqlLinter().lintDocument(document);
  }
}
