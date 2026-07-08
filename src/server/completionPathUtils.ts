import type { DatabaseKind } from "../contracts/database";
import { getDatabaseDialectTraits } from "../core/dialectTraits";

export interface CompletionMetadataLookupTarget {
  database?: string;
  schema?: string;
  table: string;
}

export interface MetadataLookupOptions {
  netezzaSchemasEnabled?: boolean;
  netezzaDefaultSchemaForDatabase?: string;
}

export function usesDatabaseObjectTwoPartName(
  databaseKind?: DatabaseKind,
): boolean {
  return (
    getDatabaseDialectTraits(databaseKind).qualification.twoPartNameStyle ===
    "database-object"
  );
}

export function supportsDoubleDotPath(databaseKind?: DatabaseKind): boolean {
  return getDatabaseDialectTraits(databaseKind).completion.supportsDoubleDotPath;
}

export function shouldTreatSingleDotPathAsSchema(
  databaseKind?: DatabaseKind,
): boolean {
  return (
    getDatabaseDialectTraits(databaseKind).completion.singleDotPathNamespace !==
    "database"
  );
}

export function isNetezzaDoubleDotSource(
  source: { db?: string; schema?: string; table: string },
  databaseKind?: DatabaseKind,
): boolean {
  return databaseKind === "netezza" && !!source.db && source.schema === undefined;
}

export function buildMetadataLookupTargets(
  source: { db?: string; schema?: string; table: string },
  effectiveDb: string | undefined,
  effectiveSchema: string | undefined,
  databaseKind?: DatabaseKind,
  lookupOptions?: MetadataLookupOptions,
): CompletionMetadataLookupTarget[] {
  const primaryTarget = resolveMetadataLookupTarget(
    source,
    effectiveDb,
    effectiveSchema,
    databaseKind,
    lookupOptions,
  );
  const normalizedTarget = normalizeMetadataLookupTargetCase(
    primaryTarget,
    databaseKind,
  );

  if (
    !normalizedTarget ||
    metadataLookupTargetsEqual(primaryTarget, normalizedTarget)
  ) {
    return [primaryTarget];
  }

  return [primaryTarget, normalizedTarget];
}

function resolveMetadataLookupTarget(
  source: { db?: string; schema?: string; table: string },
  effectiveDb: string | undefined,
  effectiveSchema: string | undefined,
  databaseKind?: DatabaseKind,
  lookupOptions?: MetadataLookupOptions,
): CompletionMetadataLookupTarget {
  if (usesDatabaseObjectTwoPartName(databaseKind)) {
    return {
      database: source.db || source.schema || effectiveDb,
      table: source.table,
    };
  }

  if (databaseKind === "snowflake" || databaseKind === "mssql") {
    return {
      database: source.db || effectiveDb,
      schema: source.schema || effectiveSchema,
      table: source.table,
    };
  }

  if (databaseKind === "db2" && source.db && !source.schema) {
    return {
      database: undefined,
      schema: source.schema || effectiveSchema,
      table: source.table,
    };
  }

  if (isNetezzaDoubleDotSource(source, databaseKind)) {
    if (lookupOptions?.netezzaSchemasEnabled === true) {
      return {
        database: source.db,
        schema: lookupOptions.netezzaDefaultSchemaForDatabase || "ADMIN",
        table: source.table,
      };
    }
    return {
      database: source.db,
      schema: undefined,
      table: source.table,
    };
  }

  return {
    database: source.db || effectiveDb,
    schema: source.schema || effectiveSchema,
    table: source.table,
  };
}

function normalizeMetadataLookupTargetCase(
  target: CompletionMetadataLookupTarget,
  databaseKind?: DatabaseKind,
): CompletionMetadataLookupTarget | undefined {
  const normalizeCase = getDeterministicLookupCaseNormalizer(databaseKind);
  if (!normalizeCase) {
    return undefined;
  }

  return {
    database: target.database ? normalizeCase(target.database) : undefined,
    schema: target.schema ? normalizeCase(target.schema) : undefined,
    table: normalizeCase(target.table),
  };
}

function getDeterministicLookupCaseNormalizer(
  databaseKind?: DatabaseKind,
): ((value: string) => string) | undefined {
  switch (databaseKind) {
    case "postgresql":
    case "vertica":
      return (value: string) => value.toLowerCase();
    case "snowflake":
    case "db2":
    case "oracle":
    case "netezza":
      return (value: string) => value.toUpperCase();
    default:
      return undefined;
  }
}

function metadataLookupTargetsEqual(
  left: CompletionMetadataLookupTarget,
  right: CompletionMetadataLookupTarget,
): boolean {
  return (
    left.database === right.database &&
    left.schema === right.schema &&
    left.table === right.table
  );
}
