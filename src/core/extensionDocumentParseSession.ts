import * as vscode from "vscode";
import type { DatabaseKind } from "../contracts/database";
import {
  DocumentParseSession,
  resolveSqlRenameSymbolWithSession,
} from "../sqlParser/documentParseSession";
import type { SqlRenameResolution } from "../sqlParser/symbols";
import { SqlParser } from "../sql/sqlParser";

let session: DocumentParseSession | undefined;

export function getExtensionDocumentParseSession(): DocumentParseSession {
  if (!session) {
    session = new DocumentParseSession();
  }
  return session;
}

export function registerExtensionDocumentParseSessionLifecycle(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const documentUri = doc.uri.toString();
      getExtensionDocumentParseSession().invalidateDocument(documentUri);
      SqlParser.clearDocumentCache(documentUri);
    }),
  );
}

/** Test-only reset. */
export function resetExtensionDocumentParseSessionForTests(): void {
  session?.clear();
  session = undefined;
}

export function resolveExtensionSqlRenameSymbol(
  document: vscode.TextDocument,
  offset: number,
  databaseKind?: DatabaseKind,
): SqlRenameResolution | undefined {
  return resolveSqlRenameSymbolWithSession(
    getExtensionDocumentParseSession(),
    {
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      sql: document.getText(),
      databaseKind,
    },
    offset,
  );
}
