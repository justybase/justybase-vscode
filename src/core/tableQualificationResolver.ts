import type { ConnectionManager } from "./connectionManager";
import type { MetadataCache } from "../metadataCache";
import type { ObjectWithSchema } from "../metadata/types";
import { extractLabel } from "../metadata/helpers";
import {
  formatQualifiedObjectName,
  stripIdentifierQuoting,
} from "../utils/identifierUtils";
import type { DatabaseKind } from "../contracts/database";

export interface TableQualificationRequest {
  database?: string;
  schema?: string;
  name: string;
  documentUri?: string;
  databaseKind?: DatabaseKind;
}

export interface QualificationProposal {
  database: string;
  schema: string;
  name: string;
  qualifiedText: string;
  isPreferred?: boolean;
}

export interface TableQualificationResolverDeps {
  metadataCache: MetadataCache;
  connectionManager: ConnectionManager;
  defaultConnectionName?: string;
}

const MAX_PROPOSALS = 6;

export function proposeTableQualification(
  deps: TableQualificationResolverDeps,
  request: TableQualificationRequest,
): QualificationProposal[] {
  const connectionName = resolveConnectionName(deps, request.documentUri);
  if (!connectionName) {
    return [];
  }

  const databaseKind = resolveDatabaseKind(deps, connectionName, request.databaseKind);
  const tableName = normalizeLookupIdentifier(request.name, databaseKind);
  if (!tableName || (request.database && request.schema)) {
    return [];
  }

  const database = normalizeLookupIdentifier(request.database, databaseKind);
  const schema = normalizeLookupIdentifier(request.schema, databaseKind);

  // MySQL uses DATABASE.TABLE as its complete two-part object name. It must
  // never be treated as a partially qualified schema.table reference.
  if (databaseKind === "mysql" && database && !schema) {
    return [];
  }
  const effectiveDb = resolveEffectiveDatabase(
    deps,
    connectionName,
    request.documentUri,
  );

  if (database) {
    return buildSchemaProposals(
      deps,
      connectionName,
      database,
      request.name,
      tableName,
      request.database ?? database,
      databaseKind,
    );
  }

  if (schema) {
    if (databaseKind === "mysql") {
      return buildMysqlProposals(
        deps,
        connectionName,
        schema,
        request.name,
        tableName,
        effectiveDb,
      );
    }
    return buildDatabaseProposals(
      deps,
      connectionName,
      schema,
      request.name,
      tableName,
      effectiveDb,
      request.schema ?? schema,
      databaseKind,
    );
  }

  if (!effectiveDb) {
    return [];
  }

  if (databaseKind === "mysql") {
    return buildMysqlProposals(
      deps,
      connectionName,
      effectiveDb,
      request.name,
      tableName,
      effectiveDb,
    );
  }

  return buildSchemaProposals(
    deps,
    connectionName,
    effectiveDb,
    request.name,
    tableName,
    effectiveDb,
    databaseKind,
  );
}

function buildSchemaProposals(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  database: string,
  originalTableName: string,
  tableLookupName: string,
  displayDatabase: string,
  databaseKind: DatabaseKind | undefined,
): QualificationProposal[] {
  const preferredSchema = resolvePreferredSchema(deps, connectionName, database);
  const schemaCandidates = findSchemaCandidates(
    deps.metadataCache.getObjectsWithSchema(connectionName, database),
    tableLookupName,
  );
  const resolvedPreferredSchema = preferredSchema
    ?? schemaCandidates.find((schema) => equalName(schema, "ADMIN"));
  const schemas = schemaCandidates.length > 0
    ? schemaCandidates
    : resolvedPreferredSchema
      ? [resolvedPreferredSchema]
      : [];

  return toSchemaProposals(
    displayDatabase,
    schemas,
    originalTableName,
    resolvedPreferredSchema,
    databaseKind,
  );
}

function buildDatabaseProposals(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  schema: string,
  originalTableName: string,
  tableLookupName: string,
  effectiveDb: string | undefined,
  displaySchema: string,
  databaseKind: DatabaseKind | undefined,
): QualificationProposal[] {
  const dbCandidates = findDatabaseCandidates(
    deps,
    connectionName,
    schema,
    tableLookupName,
  );
  const databases = dbCandidates.length > 0
    ? dbCandidates
    : effectiveDb
      ? [effectiveDb]
      : [];

  return dedupeProposals(
    databases.map((database) => {
      const isPreferred = !!effectiveDb && equalName(database, effectiveDb);
      return {
        database,
        schema: displaySchema,
        name: originalTableName,
        qualifiedText: formatQualifiedObjectName(
          database,
          displaySchema,
          originalTableName,
          databaseKind,
        ),
        isPreferred,
      };
    }),
  ).slice(0, MAX_PROPOSALS);
}

function toSchemaProposals(
  database: string,
  schemas: readonly string[],
  tableName: string,
  preferredSchema: string | undefined,
  databaseKind: DatabaseKind | undefined,
): QualificationProposal[] {
  return dedupeProposals(
    schemas.map((schema) => {
      const isPreferred = !!preferredSchema && equalName(schema, preferredSchema);
      return {
        database,
        schema,
        name: tableName,
        qualifiedText: formatQualifiedObjectName(
          database,
          schema,
          tableName,
          databaseKind,
        ),
        isPreferred,
      };
    }),
  )
    .sort((left, right) => Number(!!right.isPreferred) - Number(!!left.isPreferred))
    .slice(0, MAX_PROPOSALS);
}

function buildMysqlProposals(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  database: string,
  originalTableName: string,
  tableLookupName: string,
  effectiveDatabase: string | undefined,
): QualificationProposal[] {
  const objects = deps.metadataCache.getObjectsWithSchema(connectionName, database);
  const matchingObjects = objects.filter((objectInfo) =>
    equalName(getObjectName(objectInfo), tableLookupName),
  );
  const metadataSchema = matchingObjects[0]?.schema;
  const databaseName = matchingObjects.length > 0
    ? database
    : effectiveDatabase && equalName(effectiveDatabase, database)
      ? effectiveDatabase
      : database;

  if (matchingObjects.length === 0 && !databaseName) {
    return [];
  }

  return [{
    database: databaseName,
    schema: metadataSchema ?? "",
    name: originalTableName,
    qualifiedText: formatQualifiedObjectName(
      databaseName,
      metadataSchema,
      originalTableName,
      "mysql",
    ),
    isPreferred: !!effectiveDatabase && equalName(databaseName, effectiveDatabase),
  }];
}

function findSchemaCandidates(
  objects: ObjectWithSchema[],
  tableLookupName: string,
): string[] {
  const schemas: string[] = [];
  const seen = new Set<string>();
  for (const objectInfo of objects) {
    const objectName = getObjectName(objectInfo);
    if (!objectName || !equalName(objectName, tableLookupName)) {
      continue;
    }
    const schema = objectInfo.schema;
    const key = schema.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      schemas.push(schema);
    }
  }
  return schemas;
}

function findDatabaseCandidates(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  schema: string,
  tableLookupName: string,
): string[] {
  const dbNames = getCachedDatabaseNames(deps.metadataCache, connectionName);
  const matches: string[] = [];
  for (const dbName of dbNames) {
    const objects = deps.metadataCache.getObjectsWithSchema(connectionName, dbName);
    if (
      objects.some(
        (objectInfo) =>
          equalName(objectInfo.schema, schema) &&
          equalName(getObjectName(objectInfo), tableLookupName),
      )
    ) {
      matches.push(dbName);
    }
  }
  return matches;
}

function getObjectName(objectInfo: ObjectWithSchema): string | undefined {
  return (
    objectInfo.item.OBJNAME ||
    objectInfo.item.TABLENAME ||
    extractLabel(objectInfo.item)
  );
}

function resolvePreferredSchema(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  database: string,
): string | undefined {
  return (
    deps.metadataCache.getCurrentSchema(connectionName, database) ||
    getConfiguredSchema(deps.connectionManager.getConnectionMetadata(connectionName))
  );
}

function getConfiguredSchema(
  details: ReturnType<ConnectionManager["getConnectionMetadata"]>,
): string | undefined {
  if (!details) {
    return undefined;
  }
  const detailRecord = details as unknown as Record<string, unknown>;
  const schema = detailRecord.schema;
  if (typeof schema === "string" && schema.trim()) {
    return schema.trim();
  }
  const searchPath = details.options?.searchPath;
  if (typeof searchPath === "string") {
    return searchPath.split(",")[0]?.trim() || undefined;
  }
  return undefined;
}

function resolveEffectiveDatabase(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  documentUri: string | undefined,
): string | undefined {
  const documentDb = documentUri
    ? deps.connectionManager.getDocumentDatabase(documentUri)
    : undefined;
  if (documentDb?.trim()) {
    return documentDb.trim();
  }

  const details = deps.connectionManager.getConnectionMetadata(connectionName);
  if (details?.database?.trim()) {
    return details.database.trim();
  }

  const cachedDbNames = getCachedDatabaseNames(deps.metadataCache, connectionName);
  return cachedDbNames.length === 1 ? cachedDbNames[0] : undefined;
}

function resolveConnectionName(
  deps: TableQualificationResolverDeps,
  documentUri: string | undefined,
): string | undefined {
  return (
    deps.defaultConnectionName ||
    deps.connectionManager.resolveConnectionName?.(documentUri) ||
    deps.connectionManager.getActiveConnectionName() ||
    undefined
  );
}

function resolveDatabaseKind(
  deps: TableQualificationResolverDeps,
  connectionName: string,
  requestedKind: DatabaseKind | undefined,
): DatabaseKind | undefined {
  return requestedKind ?? deps.connectionManager.getConnectionDatabaseKind?.(connectionName);
}

function getCachedDatabaseNames(
  metadataCache: MetadataCache,
  connectionName: string,
): string[] {
  const dbs = metadataCache.getDatabases(connectionName);
  if (!dbs) {
    return [];
  }
  return dbs
    .map((db) => db.DATABASE || (typeof db.label === "string" ? db.label : undefined))
    .filter((dbName): dbName is string => !!dbName)
    .map((dbName) => dbName.toUpperCase());
}

function normalizeLookupIdentifier(
  value: string | undefined,
  databaseKind?: DatabaseKind,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = stripIdentifierQuoting(value, databaseKind);
  return normalized.trim() || undefined;
}

function equalName(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return !!left && !!right && left.toUpperCase() === right.toUpperCase();
}

function dedupeProposals(
  proposals: QualificationProposal[],
): QualificationProposal[] {
  const seen = new Set<string>();
  const unique: QualificationProposal[] = [];
  for (const proposal of proposals) {
    const key = proposal.qualifiedText.toUpperCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(proposal);
  }
  return unique;
}
