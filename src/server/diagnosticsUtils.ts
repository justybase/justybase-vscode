import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range,
} from "vscode-languageserver/node";
import type { ValidationError } from "../sqlParser";

export interface TableReference {
  database?: string;
  schema?: string;
  table: string;
}

export function extractTableReferences(sql: string): TableReference[] {
  const pattern =
    /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM|TRUNCATE\s+TABLE|GROOM\s+TABLE|COMMENT\s+ON\s+(?:TABLE|VIEW|PROCEDURE)|DROP\s+TABLE|ALTER\s+TABLE|LOCK\s+TABLE)\s+([A-Za-z0-9_."$]+(?:\.\.[A-Za-z0-9_."$]+)?)/gi;
  const references = new Map<string, TableReference>();
  let match = pattern.exec(sql);
  while (match) {
    const parsed = parseQualifiedReference(match[1]);
    if (parsed) {
      const key = `${(parsed.database || "").toUpperCase()}|${(parsed.schema || "").toUpperCase()}|${parsed.table.toUpperCase()}`;
      references.set(key, parsed);
    }
    match = pattern.exec(sql);
  }
  return Array.from(references.values());
}

export function parseQualifiedReference(
  rawValue: string | undefined,
): TableReference | undefined {
  if (!rawValue) {
    return undefined;
  }

  const sanitized = rawValue.replace(/[;,)]*$/, "").trim();
  if (!sanitized || sanitized.startsWith("(")) {
    return undefined;
  }

  if (sanitized.includes("..")) {
    const parts = sanitized.split("..");
    if (parts.length !== 2) {
      return undefined;
    }

    const database = normalizeIdentifier(parts[0]);
    const table = normalizeIdentifier(parts[1]);
    if (!table) {
      return undefined;
    }
    return { database, table };
  }

  const parts = sanitized
    .split(".")
    .map((part) => normalizeIdentifier(part))
    .filter((part): part is string => !!part);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length === 1) {
    return { table: parts[0] };
  }
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { database: parts[0], schema: parts[1], table: parts[2] };
}

export function normalizeIdentifier(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function toDiagnostic(issue: ValidationError): Diagnostic {
  const diagnostic: Diagnostic = {
    range: validationPositionToRange(issue),
    severity: toDiagnosticSeverity(issue.severity),
    message: `${issue.code}: ${issue.message}`,
    source: "SQL LSP",
    code: issue.code,
  };
  if (issue.suggestedFix) {
    (diagnostic as Record<string, unknown>).data = { suggestedFix: issue.suggestedFix };
  }
  return diagnostic;
}

export function validationPositionToRange(issue: ValidationError): Range {
  const startLine = Math.max(0, issue.position.startLine - 1);
  const startCharacter = Math.max(0, issue.position.startColumn - 1);
  const endLine = Math.max(startLine, issue.position.endLine - 1);
  const rawEndCharacter = Math.max(0, issue.position.endColumn - 1);
  const endCharacter =
    endLine === startLine
      ? Math.max(startCharacter + 1, rawEndCharacter)
      : rawEndCharacter;

  return Range.create(
    Position.create(startLine, startCharacter),
    Position.create(endLine, endCharacter),
  );
}

export function toDiagnosticSeverity(
  severity: ValidationError["severity"],
): DiagnosticSeverity {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    case "information":
      return DiagnosticSeverity.Information;
    case "hint":
      return DiagnosticSeverity.Hint;
    default:
      return DiagnosticSeverity.Warning;
  }
}

export function isDiagnosticsSuperseded(
  diagnosticsGeneration: Map<string, number>,
  documentUri: string,
  currentGen: number,
  documentVersion: number,
  versionAtStart: number,
): boolean {
  return (
    diagnosticsGeneration.get(documentUri) !== currentGen ||
    documentVersion !== versionAtStart
  );
}

export function nextDiagnosticsGeneration(
  diagnosticsGeneration: Map<string, number>,
  documentUri: string,
): number {
  const currentGen = (diagnosticsGeneration.get(documentUri) ?? 0) + 1;
  diagnosticsGeneration.set(documentUri, currentGen);
  return currentGen;
}
