import { NETEZZA_UNQUOTED_IDENTIFIER_PATTERN } from "../netezza/identifierPattern";

export function isQuotedIdentifier(identifier: string): boolean {
  const trimmed = identifier.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

export function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  return isQuotedIdentifier(trimmed) ? trimmed.slice(1, -1).replace(/""/g, '"') : trimmed;
}

export function stripIdentifierQuoting(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).replace(/\]\]/g, "]");
  }
  return unquoteIdentifier(trimmed);
}

function formatIdentifier(identifier: string): string {
  const unquoted = unquoteIdentifier(identifier);
  return NETEZZA_UNQUOTED_IDENTIFIER_PATTERN.test(unquoted)
    ? unquoted
    : `"${unquoted.replace(/"/g, '""')}"`;
}

export function formatQualifiedObjectName(
  database: string | undefined,
  schema: string | undefined,
  name: string,
): string {
  const objectName = formatIdentifier(name);
  if (database && schema) return `${formatIdentifier(database)}.${formatIdentifier(schema)}.${objectName}`;
  if (schema) return `${formatIdentifier(schema)}.${objectName}`;
  if (database) return `${formatIdentifier(database)}..${objectName}`;
  return objectName;
}
