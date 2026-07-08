import { splitCommaSeparatedTopLevel } from "../core/parenAwareText";

/**
 * Shared helpers for procedure signature strings from catalog metadata.
 * Netezza stores the full signature in PROCEDURESIGNATURE (e.g. MY_PROC(INT, VARCHAR)).
 */
export function extractProcedureBaseName(signatureOrName: string): string {
  const withoutParens = signatureOrName.split("(")[0]?.trim() ?? signatureOrName;
  const parts = withoutParens.split(".");
  return parts[parts.length - 1] ?? withoutParens;
}

export function parseProcedureArgumentNames(signature: string): string[] {
  const openParen = signature.indexOf("(");
  const closeParen = signature.lastIndexOf(")");
  if (openParen < 0 || closeParen <= openParen) {
    return [];
  }
  const argsSection = signature.slice(openParen + 1, closeParen).trim();
  if (!argsSection) {
    return [];
  }
  return splitCommaSeparatedTopLevel(argsSection)
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0);
}

export function procedureMatchesCallName(
  callProcedureName: string,
  metadataProcedureName: string,
): boolean {
  return (
    extractProcedureBaseName(metadataProcedureName).toUpperCase() ===
    callProcedureName.toUpperCase()
  );
}
