import * as path from "path";
import * as vscode from "vscode";
import type { DatabaseKind } from "../contracts/database";
import type { ConnectionManager } from "../core/connectionManager";
import type { MetadataCache } from "../metadataCache";
import { getCachedColumnsFromMetadataCacheAsync } from "../metadata/columnCacheLookup";
import { getTablesForScope } from "../metadata/cache/schemaTreeDataSource";
import { extractLabel, inferObjectType } from "../metadata/helpers";
import { parseProcedureArgumentNames } from "../metadata/procedureSignatureUtils";
import type {
  ColumnMetadata,
  ProcedureMetadata,
  TableMetadata,
} from "../metadata/types";
import { MetadataProvider } from "../providers/providers/metadataProvider";
import {
  resolveNetezzaDefaultSchema,
  resolveNetezzaSchemasEnabled,
} from "../dialects/netezza/metadata/netezzaSchemaContext";
import { getLogger } from "../utils/logger";
import { SQL_AUTHORING_LANGUAGE_IDS } from "../utils/sqlLanguage";
import {
  NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION,
  NETEZZA_GET_METADATA_REQUEST,
  NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION,
  type DocumentContextChangedParams,
  type MetadataCacheInvalidatedParams,
  type MetadataColumnItem,
  type MetadataContextResponse,
  type MetadataObjectItem,
  type MetadataRequestParams,
  type MetadataResponse,
  type MetadataTableInfoResponse,
} from "../lsp/protocol";

interface LanguageClientLike {
  onRequest(
    method: string,
    handler: (params: MetadataRequestParams) => Promise<MetadataResponse>,
  ): void;
  sendNotification(method: string, params?: unknown): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface LanguageClientConstructor {
  new (
    id: string,
    name: string,
    serverOptions: unknown,
    clientOptions: unknown,
  ): LanguageClientLike;
}

interface LanguageClientModule {
  LanguageClient: LanguageClientConstructor;
  TransportKind: {
    ipc: unknown;
  };
}

let sqlLanguageClient: LanguageClientLike | undefined;
let sqlLanguageClientStartPromise: Promise<void> | undefined;
let sqlLanguageClientReady = false;

/** True when the SQL language server client is active or starting (LSP owns parser diagnostics). */
export function isSqlLanguageClientRunning(): boolean {
  return sqlLanguageClient !== undefined || sqlLanguageClientStartPromise !== undefined;
}

/** True when the SQL language server has finished starting and can serve LSP requests. */
export function isSqlLanguageClientReady(): boolean {
  return sqlLanguageClientReady;
}

const LSP_DOCUMENT_SCHEMES = new Set([
  "file",
  "untitled",
  "vscode-notebook-cell",
]);

/** True when LSP is ready and the document scheme is attached to the language client. */
export function isSqlLanguageClientReadyForDocument(
  document: vscode.TextDocument,
): boolean {
  return (
    isSqlLanguageClientReady() &&
    LSP_DOCUMENT_SCHEMES.has(document.uri.scheme)
  );
}

export async function startSqlLanguageClient(
  context: vscode.ExtensionContext,
  metadataCache: MetadataCache,
  connectionManager: ConnectionManager,
): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (sqlLanguageClient) {
    return;
  }
  if (sqlLanguageClientStartPromise) {
    return sqlLanguageClientStartPromise;
  }

  sqlLanguageClientStartPromise = (async () => {
    const languageClientModule =
      require("vscode-languageclient/node") as LanguageClientModule;
    const LanguageClient = languageClientModule.LanguageClient;
    const TransportKind = languageClientModule.TransportKind;

    const serverModule = context.asAbsolutePath(
      path.join("dist", "server", "main.js"),
    );
    const serverOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc },
    };

    const clientOptions = {
      documentSelector: SQL_AUTHORING_LANGUAGE_IDS.flatMap((language) => [
        { scheme: "file", language },
        { scheme: "untitled", language },
        { scheme: "vscode-notebook-cell", language },
      ]),
      synchronize: {
        configurationSection: [
          "justybase.linter",
          "justybase.sql",
          "netezza.linter",
          "netezza.sql",
        ],
      },
    };

    const metadataProvider = new MetadataProvider(
      context,
      metadataCache,
      connectionManager,
    );
    const client = new LanguageClient(
      "netezza-sql-language-server",
      "Netezza SQL Language Server",
      serverOptions,
      clientOptions,
    );
    sqlLanguageClient = client;

    client.onRequest(
      NETEZZA_GET_METADATA_REQUEST,
      async (params: MetadataRequestParams): Promise<MetadataResponse> => {
        return handleMetadataRequest(
          params,
          context,
          metadataProvider,
          metadataCache,
          connectionManager,
        );
      },
    );

    context.subscriptions.push(
      connectionManager.onDidChangeDocumentConnection((documentUri: string) => {
        client.sendNotification(NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION, {
          documentUri,
        } satisfies DocumentContextChangedParams);
      }),
      connectionManager.onDidChangeDocumentDatabase((documentUri: string) => {
        client.sendNotification(NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION, {
          documentUri,
        } satisfies DocumentContextChangedParams);
      }),
      metadataCache.onDidInvalidate(() => {
        client.sendNotification(NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION);
      }),
      metadataCache.onDidExternalRefresh((connectionName) => {
        client.sendNotification(
          NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION,
          { connectionName } satisfies MetadataCacheInvalidatedParams,
        );
      }),
    );

    context.subscriptions.push({
      dispose: () => {
        void stopSqlLanguageClient();
      },
    });

    await client.start();
    sqlLanguageClientReady = true;
  })();

  try {
    await sqlLanguageClientStartPromise;
  } catch (error) {
    sqlLanguageClient = undefined;
    sqlLanguageClientReady = false;
    throw error;
  } finally {
    sqlLanguageClientStartPromise = undefined;
  }
}

export async function stopSqlLanguageClient(): Promise<void> {
  const client = sqlLanguageClient;
  if (!client) {
    return;
  }

  sqlLanguageClient = undefined;
  sqlLanguageClientStartPromise = undefined;
  sqlLanguageClientReady = false;
  await client.stop();
}

export function notifyDocumentContextChanged(documentUri: string): void {
  const client = sqlLanguageClient;
  if (!client) {
    return;
  }
  void client.sendNotification(NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION, {
    documentUri,
  } satisfies DocumentContextChangedParams);
}

export async function handleMetadataRequest(
  params: MetadataRequestParams,
  context: vscode.ExtensionContext,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
  connectionManager: ConnectionManager,
): Promise<MetadataResponse> {
  const logger = getLogger();
  const resolvedContext = await resolveMetadataContext(
    params.documentUri,
    connectionManager,
    metadataCache,
    context,
  );
  const connectionName = resolvedContext.connectionName;
  const effectiveDatabase = params.database || resolvedContext.effectiveDatabase;

  try {
    switch (params.kind) {
      case "context":
        return resolvedContext;
      case "databases":
        return await getDatabases(
          connectionName,
          metadataProvider,
          metadataCache,
        );
      case "schemas":
        if (!connectionName || !effectiveDatabase) {
          return [];
        }
        return await getSchemas(
          connectionName,
          effectiveDatabase,
          metadataProvider,
          metadataCache,
        );
      case "tables":
        if (!connectionName || !effectiveDatabase) {
          return [];
        }
        return await getTables(
          connectionName,
          effectiveDatabase,
          params.schema,
          metadataProvider,
          metadataCache,
          "table",
        );
      case "views":
        if (!connectionName || !effectiveDatabase) {
          return [];
        }
        return await getTables(
          connectionName,
          effectiveDatabase,
          params.schema,
          metadataProvider,
          metadataCache,
          "view",
        );
      case "procedures":
        if (!connectionName || !effectiveDatabase) {
          return [];
        }
        return await getProcedures(
          connectionName,
          effectiveDatabase,
          params.schema,
          metadataProvider,
          metadataCache,
        );
      case "columns":
        if (!connectionName || !effectiveDatabase || !params.table) {
          return [];
        }
        return await getColumns(
          connectionName,
          effectiveDatabase,
          params.schema,
          params.table,
          metadataProvider,
        );
      case "cachedTableInfo":
        if (!params.table) {
          return null;
        }
        return await getCachedTableInfo(
          connectionName,
          effectiveDatabase,
          params.schema,
          params.table,
          metadataCache,
          resolvedContext.databaseKind,
        );
      case "tableInfo":
        if (!params.table) {
          return null;
        }
        return await getTableInfo(
          connectionName,
          effectiveDatabase,
          params.schema,
          params.table,
          metadataProvider,
          metadataCache,
        );
      case "warmDatabaseColumns":
        if (!connectionName || !params.databases?.length) {
          return null;
        }
        await metadataProvider.warmDatabaseColumns(
          connectionName,
          params.databases,
        );
        return null;
      case "netezzaDefaultSchema":
        if (!connectionName || !effectiveDatabase) {
          return "ADMIN";
        }
        return resolveNetezzaDefaultSchema(
          connectionName,
          effectiveDatabase,
          connectionManager,
          metadataCache,
          context,
        );
      case "qualifyTable": {
        if (!params.table) {
          return [];
        }
        if (!connectionName) {
          return [];
        }
        const { proposeTableQualification } = await import(
          "../core/tableQualificationResolver"
        );
        return proposeTableQualification(
          { metadataCache, connectionManager, defaultConnectionName: connectionName },
          {
            database: params.database,
            schema: params.schema,
            name: params.table,
            documentUri: params.documentUri,
          },
        );
      }
      default:
        return null;
    }
  } catch (error: unknown) {
    logger.error("LSP metadata request failed", {
      kind: params.kind,
      documentUri: params.documentUri,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveMetadataContext(
  documentUri: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  context: vscode.ExtensionContext,
): Promise<MetadataContextResponse> {
  await connectionManager.ensureFullyLoaded();
  const connectionName =
    connectionManager.getConnectionForExecution(documentUri) || undefined;
  const effectiveDatabase =
    (await connectionManager.getEffectiveDatabase(documentUri)) || undefined;
  const databaseKind = connectionManager.getExecutionDatabaseKind(
    documentUri,
  ) as DatabaseKind | undefined;
  // Don't hardcode effectiveSchema - let it be undefined and derive from
  // the active connection/session context. The completion engine will
  // handle unqualified table references appropriately based on database kind.
  // For schema-object dialects (PostgreSQL, Vertica, Snowflake, etc.),
  // the actual search_path/current_schema should be used, not a hardcoded default.
  const effectiveSchema = await connectionManager.getEffectiveSchema?.(documentUri) || undefined;

  let netezzaSchemasEnabled: boolean | undefined;
  if (databaseKind === "netezza" && connectionName) {
    netezzaSchemasEnabled = await resolveNetezzaSchemasEnabled(
      connectionName,
      connectionManager,
      metadataCache,
      context,
    );
  }

  return {
    connectionName,
    effectiveDatabase,
    effectiveSchema,
    databaseKind,
    netezzaSchemasEnabled,
  };
}

async function getDatabases(
  connectionName: string | undefined,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
): Promise<MetadataObjectItem[]> {
  if (!connectionName) {
    return [];
  }

  let databases = metadataCache.getDatabases(connectionName);
  if (!databases) {
    await metadataProvider.getDatabases(connectionName);
    databases = metadataCache.getDatabases(connectionName);
  }

  if (!databases) {
    return [];
  }

  const items: MetadataObjectItem[] = [];
  for (const item of databases) {
    const name = normalizeName(item.DATABASE || extractLabel(item));
    if (!name) {
      continue;
    }
    items.push({
      name,
      detail: item.detail,
    });
  }
  return items;
}

async function getSchemas(
  connectionName: string,
  database: string,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
): Promise<MetadataObjectItem[]> {
  let schemas = metadataCache.getSchemas(connectionName, database);
  if (!schemas) {
    await metadataProvider.getSchemas(connectionName, database);
    schemas = metadataCache.getSchemas(connectionName, database);
  }

  if (!schemas) {
    return [];
  }

  const items: MetadataObjectItem[] = [];
  for (const item of schemas) {
    const name = normalizeName(item.SCHEMA || extractLabel(item));
    if (!name) {
      continue;
    }
    items.push({
      name,
      database,
      detail: item.detail,
    });
  }
  return items;
}

async function getTables(
  connectionName: string,
  database: string,
  schema: string | undefined,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
  expectedType: "table" | "view",
): Promise<MetadataObjectItem[]> {
  const readCachedTables = (): TableMetadata[] | undefined =>
    getTablesForScope(metadataCache, connectionName, database, schema);
  const toMetadataItems = (
    items: TableMetadata[] | undefined,
  ): MetadataObjectItem[] =>
    (items ?? [])
      .map((item) => mapTableMetadata(item, database))
      .filter(
        (item): item is MetadataObjectItem =>
          !!item && item.objectType === expectedType,
      );

  let tables = readCachedTables();
  let matchingItems = toMetadataItems(tables);

  if (!tables) {
    // Cache MISS — no data at all for this DB/schema, need to fetch from server
    if (expectedType === "view") {
      await metadataProvider.getViews(connectionName, database, schema);
    } else {
      await metadataProvider.getTables(connectionName, database, schema);
    }
    tables = readCachedTables();
    matchingItems = toMetadataItems(tables);
  } else if (expectedType === "view" && matchingItems.length === 0) {
    // Cache has objects but no views (e.g. tables-only prefetch on DB2/Oracle)
    await metadataProvider.getViews(connectionName, database, schema);
    tables = readCachedTables();
    matchingItems = toMetadataItems(tables);
  }

  return matchingItems;
}

async function getProcedures(
  connectionName: string,
  database: string,
  schema: string | undefined,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
): Promise<MetadataObjectItem[]> {
  const cacheKey = schema ? `${database}.${schema}` : `${database}..`;
  let procedures = schema
    ? metadataCache.getProcedures(connectionName, cacheKey)
    : (metadataCache.getProcedures(connectionName, cacheKey) ??
      metadataCache.getProceduresAllSchemas(connectionName, database));

  if (!procedures) {
    await metadataProvider.getProcedures(connectionName, database, schema);
    procedures = schema
      ? metadataCache.getProcedures(connectionName, cacheKey)
      : (metadataCache.getProcedures(connectionName, cacheKey) ??
        metadataCache.getProceduresAllSchemas(connectionName, database));
  }

  if (!procedures) {
    return [];
  }

  return procedures
    .map((item) => mapProcedureMetadata(item, database))
    .filter((item): item is MetadataObjectItem => !!item);
}

async function getColumns(
  connectionName: string,
  database: string,
  schema: string | undefined,
  table: string,
  metadataProvider: MetadataProvider,
): Promise<MetadataColumnItem[]> {
  const columns = await metadataProvider.getTableColumnsMetadata(
    connectionName,
    database,
    schema,
    table,
  );
  return mapColumns(columns);
}

function findTableDescription(
  metadataCache: MetadataCache,
  connectionName: string,
  database: string,
  schema: string | undefined,
  tableName: string,
): string | undefined {
  const objects = metadataCache.getObjectsWithSchema(connectionName, database);
  if (!objects) {
    return undefined;
  }
  const normalizedTable = tableName.toUpperCase();
  const normalizedSchema = (schema || '').toUpperCase();
  for (const objectInfo of objects) {
    const name =
      typeof objectInfo.item.label === 'string'
        ? objectInfo.item.label
        : typeof objectInfo.item.label === 'object'
          ? objectInfo.item.label.label
          : objectInfo.item.OBJNAME || objectInfo.item.TABLENAME;
    if (!name || name.toUpperCase() !== normalizedTable) continue;
    if (normalizedSchema && objectInfo.schema.toUpperCase() !== normalizedSchema) continue;
    if (objectInfo.description && objectInfo.description.trim()) {
      return objectInfo.description.trim();
    }
  }
  return undefined;
}

async function getTableInfo(
  connectionName: string | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
): Promise<MetadataTableInfoResponse> {
  if (!connectionName || !database) {
    return {
      exists: true,
      table,
      database,
      schema,
      columns: [],
    };
  }

  let resolvedSchema = schema;
  if (!resolvedSchema) {
    const cachedObject = metadataCache.findObjectWithType(
      connectionName,
      database,
      undefined,
      table,
    );
    resolvedSchema = cachedObject?.schema;
  }

  const columns = await metadataProvider.getTableColumnsMetadata(
    connectionName,
    database,
    resolvedSchema,
    table,
  );

  const description = findTableDescription(
    metadataCache,
    connectionName,
    database,
    resolvedSchema,
    table,
  );

  if (columns.length > 0) {
    return {
      exists: true,
      table,
      database,
      schema: resolvedSchema ?? schema,
      description,
      columns: mapColumns(columns),
    };
  }

  const existsFromCache = findTableInCache(
    metadataCache,
    connectionName,
    database,
    resolvedSchema,
    table,
  );
  return {
    exists: existsFromCache ?? true,
    table,
    database,
    schema: resolvedSchema ?? schema,
    description,
    columns: [],
  };
}

async function getCachedTableInfo(
  connectionName: string | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  metadataCache: MetadataCache,
  databaseKind?: DatabaseKind,
): Promise<MetadataTableInfoResponse> {
  if (!connectionName || !database) {
    return {
      exists: true,
      table,
      database,
      schema,
      columns: [],
    };
  }

  let resolvedSchema = schema;
  if (!resolvedSchema) {
    const cachedObject = metadataCache.findObjectWithType(
      connectionName,
      database,
      undefined,
      table,
    );
    resolvedSchema = cachedObject?.schema;
  }

  const columns = await getCachedColumns(
    metadataCache,
    connectionName,
    database,
    resolvedSchema,
    table,
    databaseKind,
  );
  if (columns && columns.length > 0) {
    return {
      exists: true,
      table,
      database,
      schema: resolvedSchema ?? schema,
      description: findTableDescription(
        metadataCache,
        connectionName,
        database,
        resolvedSchema ?? schema,
        table,
      ),
      columns: mapColumns(columns),
    };
  }

  const existsFromCache = findTableInCache(
    metadataCache,
    connectionName,
    database,
    resolvedSchema ?? schema,
    table,
  );
  return {
    exists: existsFromCache ?? true,
    table,
    database,
    schema: resolvedSchema ?? schema,
    columns: [],
  };
}

function mapTableMetadata(
  item: TableMetadata,
  database: string,
): MetadataObjectItem | undefined {
  const name = normalizeName(
    item.OBJNAME || item.TABLENAME || extractLabel(item),
  );
  if (!name) {
    return undefined;
  }

  const objectType =
    inferObjectType(item).toUpperCase() === "VIEW" ? "view" : "table";
  return {
    name,
    database,
    schema: normalizeName(item.SCHEMA),
    objectType,
    detail: item.detail,
    description: normalizeName(item.DESCRIPTION),
  };
}

function mapProcedureMetadata(
  item: ProcedureMetadata,
  database: string,
): MetadataObjectItem | undefined {
  const name = normalizeName(
    item.PROCEDURESIGNATURE || item.PROCEDURE || extractLabel(item),
  );
  if (!name) {
    return undefined;
  }

  return {
    name,
    database,
    schema: normalizeName(item.SCHEMA),
    objectType: "procedure",
    detail: item.detail,
    argumentNames: parseProcedureArgumentNames(name),
  };
}

function mapColumns(items: ColumnMetadata[]): MetadataColumnItem[] {
  const result: MetadataColumnItem[] = [];
  for (const item of items) {
    const name = normalizeName(item.ATTNAME || item.label);
    if (!name) {
      continue;
    }
    const rawDescription =
      item.documentation
      ?? (typeof item.DESCRIPTION === "string" ? item.DESCRIPTION : undefined);
    result.push({
      name,
      type: normalizeName(item.FORMAT_TYPE || item.detail),
      description: normalizeName(rawDescription),
      isPk: item.isPk,
      isFk: item.isFk,
    });
  }
  return result;
}

async function getCachedColumns(
  metadataCache: MetadataCache,
  connectionName: string,
  database: string,
  schema: string | undefined,
  table: string,
  databaseKind?: DatabaseKind,
): Promise<ColumnMetadata[] | undefined> {
  return getCachedColumnsFromMetadataCacheAsync(
    metadataCache,
    connectionName,
    database,
    schema,
    table,
    databaseKind,
  );
}

function findTableInCache(
  metadataCache: MetadataCache,
  connectionName: string,
  database: string,
  schema: string | undefined,
  table: string,
): boolean | undefined {
  const normalizedTable = table.toUpperCase();
  const normalizedSchema = schema?.toUpperCase();
  const tables = metadataCache.getTablesAllSchemas(connectionName, database);
  if (!tables) {
    const dbs = metadataCache.getDatabases(connectionName);
    if (dbs) {
      const upperDb = database.toUpperCase();
      const dbExists = dbs.some(
        (db) => db.DATABASE.toUpperCase() === upperDb,
      );
      if (!dbExists) {
        return false;
      }
    }
    return undefined;
  }

  for (const entry of tables) {
    const name = normalizeName(
      entry.OBJNAME || entry.TABLENAME || extractLabel(entry),
    );
    if (!name || name.toUpperCase() !== normalizedTable) {
      continue;
    }

    const entrySchema = normalizeName(entry.SCHEMA);
    if (!normalizedSchema || entrySchema?.toUpperCase() === normalizedSchema) {
      return true;
    }
  }

  return false;
}

function normalizeName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
