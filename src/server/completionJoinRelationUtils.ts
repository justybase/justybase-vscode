import type { DatabaseKind } from "../contracts/database";
import { getDatabaseDialectTraits } from "../core/dialectTraits";
import type { JoinTableIdentity } from "../lsp/protocol";
import {
    createNetezzaCatalogIdentifier,
    formatNetezzaIdentifier,
    unquoteNetezzaIdentifier,
} from "../dialects/netezza/metadata/identifierUtils";
import { getTableAliasBase } from "../sql/tableAliasPolicy";
import { formatIdentifierForSql } from "../utils/identifierUtils";
import { supportsThreePartPath, usesDatabaseObjectTwoPartName } from "./completionPathUtils";

export interface JoinSourceIdentity {
  database?: string;
  schema?: string;
  table: string;
}

function unquoteIdentifier(value: string | undefined): {
  value: string;
  quoted: boolean;
} {
  const trimmed = (value ?? "").trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return {
      value: trimmed.slice(1, -1).replace(/""/gu, '"'),
      quoted: true,
    };
  }
  return { value: trimmed, quoted: false };
}

function sameIdentifier(left: string | undefined, right: string | undefined): boolean {
  const leftIdentifier = unquoteIdentifier(left);
  const rightIdentifier = unquoteIdentifier(right);
  if (leftIdentifier.quoted !== rightIdentifier.quoted) {
    return false;
  }
  if (leftIdentifier.quoted) {
    return leftIdentifier.value === rightIdentifier.value;
  }
  return leftIdentifier.value.toLocaleUpperCase() === rightIdentifier.value.toLocaleUpperCase();
}

export function matchesJoinTableIdentity(
  expected: JoinTableIdentity,
  actual: JoinSourceIdentity,
  effectiveDatabase?: string,
  effectiveSchema?: string,
): boolean {
  const expectedDatabase = expected.database ?? effectiveDatabase;
  const actualDatabase = actual.database ?? effectiveDatabase;
  const expectedSchema = expected.schema ?? effectiveSchema;
  const actualSchema = actual.schema ?? effectiveSchema;
  return sameIdentifier(expected.table, actual.table)
    && (!expectedDatabase || sameIdentifier(expectedDatabase, actualDatabase))
    && (!expectedSchema || sameIdentifier(expectedSchema, actualSchema));
}

export function formatJoinTargetPath(
  target: JoinTableIdentity,
  databaseKind: DatabaseKind | undefined,
  effectiveDatabase?: string,
  joinUsesDefaultSchema = false,
): string {
  const database = target.database ?? effectiveDatabase;
  const schema = target.schema;
  if (databaseKind === "netezza") {
    const tableName = unquoteNetezzaIdentifier(target.table);
    const normalizedTableName = schema && tableName.toLocaleUpperCase().startsWith(`${schema.toLocaleUpperCase()}.`)
      ? tableName.slice(schema.length + 1)
      : tableName;
    const databasePart = database
      ? formatNetezzaIdentifier(createNetezzaCatalogIdentifier(database))
      : undefined;
    const tablePart = formatNetezzaIdentifier(createNetezzaCatalogIdentifier(normalizedTableName));
    if (databasePart && (joinUsesDefaultSchema || !schema)) {
      return `${databasePart}..${tablePart}`;
    }
    const schemaPart = schema
      ? formatNetezzaIdentifier(createNetezzaCatalogIdentifier(schema))
      : undefined;
    return [databasePart, schemaPart, tablePart].filter(Boolean).join(".");
  }

  const traits = getDatabaseDialectTraits(databaseKind);
  const identifier = (value: string): string => formatIdentifierForSql(value, databaseKind);
  if (usesDatabaseObjectTwoPartName(databaseKind)) {
    const namespace = schema ?? database;
    return namespace ? `${identifier(namespace)}.${identifier(target.table)}` : identifier(target.table);
  }
  if (
    database
    && schema
    && supportsThreePartPath(databaseKind)
    && traits.qualification.threePartNamePrefix === "database"
  ) {
    return `${identifier(database)}.${identifier(schema)}.${identifier(target.table)}`;
  }
  if (schema) return `${identifier(schema)}.${identifier(target.table)}`;
  return identifier(target.table);
}

export function getJoinAliasBase(tableName: string): string {
  return getTableAliasBase(tableName);
}
