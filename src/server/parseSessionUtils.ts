import type { TextDocument } from "vscode-languageserver-textdocument";
import type { DatabaseKind } from "../contracts/database";
import {
  resolveSqlRenameSymbolWithSession,
  type DocumentParseSession,
} from "../sqlParser";
import { toDocumentParseRequest } from "./documentParseRequest";

export function resolveSqlRenameSymbolFromSession(
  documentParseSession: DocumentParseSession,
  document: TextDocument,
  offset: number,
  databaseKind?: DatabaseKind,
) {
  return resolveSqlRenameSymbolWithSession(
    documentParseSession,
    toDocumentParseRequest(document, document.getText(), databaseKind),
    offset,
  );
}
