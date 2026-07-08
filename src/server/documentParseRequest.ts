import type { TextDocument } from "vscode-languageserver-textdocument";
import type { DatabaseKind } from "../contracts/database";
import type { DocumentParseRequest } from "../sqlParser/documentParseSession";

export function toDocumentParseRequest(
  document: Pick<TextDocument, "uri" | "version">,
  sql: string,
  databaseKind?: DatabaseKind,
): DocumentParseRequest {
  return {
    documentUri: document.uri,
    documentVersion: document.version,
    sql,
    databaseKind,
  };
}

export function toDocumentParseRequestFromParts(
  documentUri: string,
  documentVersion: number,
  sql: string,
  databaseKind?: DatabaseKind,
): DocumentParseRequest {
  return {
    documentUri,
    documentVersion,
    sql,
    databaseKind,
  };
}
