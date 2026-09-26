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
  NETEZZA_UX_PERF_NOTIFICATION,
  type DocumentContextChangedParams,
  type MetadataCacheInvalidatedParams,
  type MetadataColumnItem,
  type MetadataContextResponse,
  type MetadataObjectItem,
  type MetadataRequestParams,
  type MetadataResponse,
  type MetadataTableInfoResponse,
  type UxPerfNotificationParams,
} from "../lsp/protocol";
import { getUxPerfSession } from "../services/perf/uxPerfSession";
import {
  getRelatedColumnRole,
  normalizeRelatedColumnName,
} from "../utils/relatedColumnNames";
import { normalizeJoinCompletionSettings } from "../lsp/joinCompletionSettings";

interface LanguageClientLike {
  onRequest(
    method: string,
    handler: (params: MetadataRequestParams) => Promise<MetadataResponse>,
  ): void;
  onNotification(
    method: string,
    handler: (params: UxPerfNotificationParams) => void,
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

interface CachedJoinColumn {
  name: string;
  normalizedName: string;
  isKey: boolean;
  joinReferences?: ColumnMetadata["joinReferences"];
}

interface CachedJoinTable {
  name: string;
  schema: string;
  item: TableMetadata;
  columns: CachedJoinColumn[];
}

interface CachedJoinTableIndexEntry {
  tables?: CachedJoinTable[];
  promise?: Promise<CachedJoinTable[]>;
  expiresAt: number;
}

const CACHED_JOIN_TABLE_INDEX_TTL_MS = 60_000;
// A failed/hung async metadata read must not pin the in-flight cache entry forever.
const PENDING_JOIN_TABLE_INDEX_TTL_MS = 10_000;
const cachedJoinTableIndexes = new WeakMap<
  MetadataCache,
  Map<string, CachedJoinTableIndexEntry>
>();

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

/**
 * Sends a notification to the language client, tolerating a client that is
 * still starting, already stopped, or failed to boot (sendNotification throws
 * "Client is not running" and may reject when the server process died).
 */
function sendNotificationSafely(
  client: LanguageClientLike,
  method: string,
  params?: unknown,
): void {
  try {
    const result = (
      params === undefined
        ? client.sendNotification(method)
        : client.sendNotification(method, params)
    ) as unknown;
    if (result instanceof Promise) {
      void result.catch(() => undefined);
    }
  } catch {
    // Client is stopped or in a failed state; the extension host re-syncs
    // context once the language server is reachable again.
  }
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
          "justybase.metadata",
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

    client.onNotification(
      NETEZZA_UX_PERF_NOTIFICATION,
      (params: UxPerfNotificationParams) => {
        getUxPerfSession().emit(params);
      },
    );

    context.subscriptions.push(
      connectionManager.onDidChangeDocumentConnection((documentUri: string) => {
        sendNotificationSafely(client, NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION, {
          documentUri,
        } satisfies DocumentContextChangedParams);
      }),
      connectionManager.onDidChangeDocumentDatabase((documentUri: string) => {
        sendNotificationSafely(client, NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION, {
          documentUri,
        } satisfies DocumentContextChangedParams);
      }),
      metadataCache.onDidInvalidate((connectionName) => {
        clearCachedJoinTableIndexes(metadataCache, connectionName);
        sendNotificationSafely(
          client,
          NETEZZA_METADATA_CACHE_INVALIDATED_NOTIFICATION,
          connectionName ? { connectionName } satisfies MetadataCacheInvalidatedParams : undefined,
        );
      }),
      metadataCache.onDidExternalRefresh((connectionName) => {
        clearCachedJoinTableIndexes(metadataCache, connectionName);
        sendNotificationSafely(
          client,
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
  try {
    await client.stop();
  } catch {
    // Client may be in a starting/startFailed state (e.g. the server process
    // died during boot); there is nothing left to stop.
  }
}

export function notifyDocumentContextChanged(documentUri: string): void {
  const client = sqlLanguageClient;
  if (!client) {
    return;
  }
  sendNotificationSafely(client, NETEZZA_DOCUMENT_CONTEXT_CHANGED_NOTIFICATION, {
    documentUri,
  } satisfies DocumentContextChangedParams);
}

/** Test hook: resolves the negative-cache fallback for table lookups. */
export function __TEST_ONLY_resolveExistsFallback(
  existsFromCache: boolean | undefined,
  databaseKind: DatabaseKind | undefined,
): boolean {
  if (databaseKind === 'file' && existsFromCache === false) {
    return true;
  }
  return existsFromCache ?? true;
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
        return {
          ...resolvedContext,
          joinCompletionSettings: getWorkspaceJoinCompletionSettings(params.documentUri),
        };
      case "databases":
        return await getDatabases(
          connectionName,
          metadataProvider,
          metadataCache,
          params.cacheOnly,
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
          params.cacheOnly,
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
          params.cacheOnly,
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
          params.cacheOnly,
        );
      case "sourceObjects":
        if (!connectionName || !effectiveDatabase) {
          return [];
        }
        return await getSourceObjects(
          connectionName,
          effectiveDatabase,
          params.schema,
          metadataProvider,
          metadataCache,
          params.cacheOnly,
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
          params.cacheOnly,
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
          params.allowPublicSynonym,
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
      case "cachedJoinTargets":
        if (!connectionName || !effectiveDatabase || !params.joinSources?.length) {
          return [];
        }
        return getCachedJoinTargets(
          connectionName,
          effectiveDatabase,
          params.joinSources,
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
          resolvedContext.databaseKind,
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

function getWorkspaceJoinCompletionSettings(documentUri: string) {
  try {
    const configuration = vscode.workspace.getConfiguration(
      "justybase.sql",
      vscode.Uri.parse(documentUri),
    );
    const rawSettings = typeof configuration.toJSON === "function"
      ? configuration.toJSON()
      : {
          joinNameHeuristics: configuration.get("joinNameHeuristics"),
          autoJoinAliases: configuration.get("autoJoinAliases"),
          joinAliases: configuration.get("joinAliases"),
          joinRelations: configuration.get("joinRelations"),
        };
    return normalizeJoinCompletionSettings(rawSettings);
  } catch {
    return normalizeJoinCompletionSettings(undefined);
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
  cacheOnly = false,
): Promise<MetadataObjectItem[]> {
  if (!connectionName) {
    return [];
  }

  let databases = metadataCache.getDatabases(connectionName);
  if (!databases && !cacheOnly) {
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
  cacheOnly = false,
): Promise<MetadataObjectItem[]> {
  let schemas = metadataCache.getSchemas(connectionName, database);
  if (!schemas && !cacheOnly) {
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
  cacheOnly = false,
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

  if (!tables && !cacheOnly) {
    // Cache MISS — no data at all for this DB/schema, need to fetch from server
    if (expectedType === "view") {
      await metadataProvider.getViews(connectionName, database, schema);
    } else {
      await metadataProvider.getTables(connectionName, database, schema);
    }
    tables = readCachedTables();
    matchingItems = toMetadataItems(tables);
  } else if (!cacheOnly && expectedType === "view" && matchingItems.length === 0) {
    // Cache has objects but no views (e.g. tables-only prefetch on DB2/Oracle)
    await metadataProvider.getViews(connectionName, database, schema);
    tables = readCachedTables();
    matchingItems = toMetadataItems(tables);
  }

  return matchingItems;
}

async function getSourceObjects(
  connectionName: string,
  database: string,
  schema: string | undefined,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
  cacheOnly = false,
): Promise<MetadataObjectItem[]> {
  if (!cacheOnly) {
    await metadataProvider.getSourceObjects(connectionName, database, schema);
  }
  const items = getTablesForScope(metadataCache, connectionName, database, schema);
  return (items ?? [])
    .map((item) => mapTableMetadata(item, database))
    .filter((item): item is MetadataObjectItem =>
      !!item &&
      (item.objectType === "table" ||
        item.objectType === "view" ||
        item.objectType === "materialized-view" ||
        item.objectType === "synonym"),
    );
}

async function getProcedures(
  connectionName: string,
  database: string,
  schema: string | undefined,
  metadataProvider: MetadataProvider,
  metadataCache: MetadataCache,
  cacheOnly = false,
): Promise<MetadataObjectItem[]> {
  const cacheKey = schema ? `${database}.${schema}` : `${database}..`;
  let procedures = schema
    ? metadataCache.getProcedures(connectionName, cacheKey)
    : (metadataCache.getProcedures(connectionName, cacheKey) ??
      metadataCache.getProceduresAllSchemas(connectionName, database));

  if (!procedures && !cacheOnly) {
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
  allowPublicSynonym: boolean | undefined,
  metadataProvider: MetadataProvider,
): Promise<MetadataColumnItem[]> {
  const columns = await metadataProvider.getTableColumnsMetadata(
    connectionName,
    database,
    schema,
    table,
    allowPublicSynonym ? { allowPublicSynonym: true } : undefined,
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
    const description = normalizeName(objectInfo.description);
    if (description) return description;
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
  // File SQL connections create their objects (views + editable table) at
  // connect time; a negative cache entry gathered before the first connect
  // is not trustworthy, so treat it as unknown instead of flagging SQL006.
  const exists = __TEST_ONLY_resolveExistsFallback(existsFromCache, databaseKind);
  return {
    exists,
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
  // File SQL connections create their objects at connect time; a negative
  // cache entry gathered before the first connect is not trustworthy.
  const exists = __TEST_ONLY_resolveExistsFallback(existsFromCache, databaseKind);
  return {
    exists,
    table,
    database,
    schema: resolvedSchema ?? schema,
    ...(columns !== undefined && databaseKind !== 'file' ? { columnsComplete: true } : {}),
    columns: [],
  };
}

function getCachedJoinTargets(
  connectionName: string,
  database: string,
  sources: Array<{ schema?: string; table: string }>,
  metadataCache: MetadataCache,
  databaseKind?: DatabaseKind,
): Promise<MetadataObjectItem[]> {
  return getCachedJoinTargetsAsync(
    connectionName,
    database,
    sources,
    metadataCache,
    databaseKind,
  );
}

async function getCachedJoinTargetsAsync(
  connectionName: string,
  database: string,
  sources: Array<{ schema?: string; table: string }>,
  metadataCache: MetadataCache,
  databaseKind?: DatabaseKind,
): Promise<MetadataObjectItem[]> {
  const resolvedSources = sources.map((source) => {
    const sourceObject = metadataCache.findObjectWithType(
      connectionName,
      database,
      source.schema,
      source.table,
    );
    const schema = source.schema?.trim() || (
      metadataCache.getDefaultSchema(connectionName, database)
      ?? sourceObject?.schema
      ?? ""
    );
    return { ...source, schema };
  });
  const sourceSchemas = [...new Set(resolvedSources.map((source) => source.schema))];
  const tableIndex = await getCachedJoinTableIndex(
    connectionName,
    database,
    metadataCache,
    sourceSchemas,
    databaseKind,
  );
  if (tableIndex.length === 0) {
    return [];
  }

  const targets = new Map<string, MetadataObjectItem>();
  const defaultSchema = metadataCache.getDefaultSchema(connectionName, database);
  for (const source of resolvedSources) {
    const sourceSchema = source.schema;
    const sourceTable = tableIndex.find((entry) =>
      entry.name.toUpperCase() === source.table.toUpperCase() &&
      entry.schema.toUpperCase() === sourceSchema.toUpperCase(),
    );
    if (!sourceTable?.columns.length) {
      continue;
    }

    for (const candidate of tableIndex) {
      const isSameSchema = candidate.schema.toUpperCase() === sourceSchema.toUpperCase();
      if (isSameSchema && candidate.name.toUpperCase() === sourceTable.name.toUpperCase()) {
        continue;
      }

      const matches: NonNullable<MetadataObjectItem["joinMatches"]> = [];
      // Exact catalog FK pairs take precedence over the fallback name/key matcher.
      for (const sourceColumn of sourceTable.columns) {
        for (const reference of sourceColumn.joinReferences ?? []) {
          if (
            reference.toTable.toUpperCase() !== candidate.name.toUpperCase() ||
            reference.toSchema.toUpperCase() !== candidate.schema.toUpperCase() ||
            (reference.toDatabase && reference.toDatabase.toUpperCase() !== database.toUpperCase())
          ) continue;
          matches.push({
            sourceTable: sourceTable.name,
            sourceSchema: sourceTable.schema || undefined,
            sourceColumn: sourceColumn.name,
            targetColumn: reference.toColumn,
            relationType: "foreignKey",
            constraintName: reference.constraintName,
            ordinalPosition: reference.ordinalPosition,
          });
        }
      }
      // Keep relationships in both directions. Two tables can have separate
      // foreign keys pointing at each other; the resolver groups each constraint.
      for (const targetColumn of candidate.columns) {
        for (const reference of targetColumn.joinReferences ?? []) {
          if (
            reference.toTable.toUpperCase() !== sourceTable.name.toUpperCase() ||
            reference.toSchema.toUpperCase() !== sourceTable.schema.toUpperCase() ||
            (reference.toDatabase && reference.toDatabase.toUpperCase() !== database.toUpperCase())
          ) continue;
          matches.push({
            sourceTable: sourceTable.name,
            sourceSchema: sourceTable.schema || undefined,
            sourceColumn: reference.toColumn,
            targetColumn: targetColumn.name,
            relationType: "foreignKey",
            constraintName: reference.constraintName,
            ordinalPosition: reference.ordinalPosition,
          });
        }
      }
      if (matches.length === 0 && isSameSchema) {
        for (const sourceColumn of sourceTable.columns) {
          for (const targetColumn of candidate.columns) {
            if (
              sourceColumn.normalizedName !== targetColumn.normalizedName ||
              (!sourceColumn.isKey && !targetColumn.isKey)
            ) {
              continue;
            }
            matches.push({
              sourceTable: sourceTable.name,
              sourceSchema: sourceTable.schema || undefined,
              sourceColumn: sourceColumn.name,
              targetColumn: targetColumn.name,
              relationType: "heuristic",
            });
          }
        }
      }
      if (matches.length === 0) {
        continue;
      }

      const item = mapTableMetadata(candidate.item, database);
      if (item) {
        const key = `${item.schema ?? ""}.${item.name}`.toUpperCase();
        const existing = targets.get(key);
        targets.set(key, {
          ...(existing ?? item),
          joinUsesDefaultSchema: Boolean(
            defaultSchema &&
            candidate.schema.toUpperCase() === defaultSchema.toUpperCase(),
          ),
          joinMatches: [
            ...(existing?.joinMatches ?? []),
            ...matches,
          ],
        });
      }
    }
  }

  return [...targets.values()];
}

async function getCachedJoinTableIndex(
  connectionName: string,
  database: string,
  metadataCache: MetadataCache,
  sourceSchemas: string[],
  databaseKind?: DatabaseKind,
): Promise<CachedJoinTable[]> {
  let cacheForMetadata = cachedJoinTableIndexes.get(metadataCache);
  if (!cacheForMetadata) {
    cacheForMetadata = new Map();
    cachedJoinTableIndexes.set(metadataCache, cacheForMetadata);
  }
  const normalizedSchemas = [...new Set(sourceSchemas.map((schema) => schema.toUpperCase()))]
    .sort();
  const key = `${connectionName.toUpperCase()}|${database.toUpperCase()}|${normalizedSchemas.join(",")}`;
  const cached = cacheForMetadata.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.tables) return cached.tables;
    if (cached.promise) return cached.promise;
  }
  cacheForMetadata.delete(key);

  const pendingPromise = (async (): Promise<CachedJoinTable[]> => {
      const allTables = metadataCache.getObjectsByType(
        connectionName,
        database,
        "TABLE",
      ) ?? [];

      const loadTableColumns = async (
        tables: typeof allTables,
      ): Promise<CachedJoinTable[]> => {
        const index: CachedJoinTable[] = [];
        let nextTableIndex = 0;
        const loadCachedColumns = async (): Promise<void> => {
          while (nextTableIndex < tables.length) {
            const table = tables[nextTableIndex];
            nextTableIndex += 1;
            const name = normalizeName(
              table.item.OBJNAME || table.item.TABLENAME || extractLabel(table.item),
            );
            if (!name) continue;
            let columns: ColumnMetadata[] | undefined;
            try {
              columns = await getCachedColumnsFromMetadataCacheAsync(
                metadataCache,
                connectionName,
                database,
                table.schema || undefined,
                name,
                databaseKind,
              );
            } catch {
              continue;
            }
            if (!columns?.length) continue;
            index.push({
              name,
              schema: table.schema,
              item: table.item,
              columns: columns.flatMap((column) => {
                const normalizedName = normalizeRelatedColumnName(column.ATTNAME);
                if (!normalizedName) return [];
                return [{
                  name: column.ATTNAME,
                  normalizedName,
                  isKey: getRelatedColumnRole({
                    name: column.ATTNAME,
                    isPk: column.isPk,
                    isFk: column.isFk,
                  }) !== "unknown",
                  joinReferences: column.joinReferences,
                }];
              }),
            });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(8, tables.length) }, () => loadCachedColumns()),
        );
        return index;
      };

      const sourceTables = allTables.filter((table) =>
        normalizedSchemas.includes(table.schema.toUpperCase()),
      );
      const sourceIndex = await loadTableColumns(sourceTables);
      // Catalog FK metadata carries exact endpoint identities, so only those
      // cross-schema target tables need to be added to the per-request index.
      const referencedTargets = new Set<string>();
      for (const table of sourceIndex) {
        for (const column of table.columns) {
          for (const reference of column.joinReferences ?? []) {
            if (
              reference.toSchema &&
              reference.toTable &&
              (!reference.toDatabase || reference.toDatabase.toUpperCase() === database.toUpperCase())
            ) {
              referencedTargets.add(
                `${reference.toSchema.toUpperCase()}|${reference.toTable.toUpperCase()}`,
              );
            }
          }
        }
      }
      const indexedTables = new Set(sourceIndex.map((table) =>
        `${table.schema.toUpperCase()}|${table.name.toUpperCase()}`,
      ));
      const referencedTables = allTables.filter((table) => {
        const schema = table.schema.toUpperCase();
        const name = normalizeName(
          table.item.OBJNAME || table.item.TABLENAME || extractLabel(table.item),
        );
        if (!name) return false;
        const key = `${schema}|${name.toUpperCase()}`;
        return referencedTargets.has(key) && !indexedTables.has(key);
      });
      const referencedIndex = await loadTableColumns(referencedTables);
      return [...sourceIndex, ...referencedIndex];
    })();
  const pendingEntry: CachedJoinTableIndexEntry = {
    expiresAt: Date.now() + PENDING_JOIN_TABLE_INDEX_TTL_MS,
    promise: pendingPromise,
  };
  cacheForMetadata.set(key, pendingEntry);
  try {
    const index = await pendingPromise;
    if (cacheForMetadata.get(key) === pendingEntry) {
      cacheForMetadata.set(key, {
        tables: index,
        expiresAt: Date.now() + CACHED_JOIN_TABLE_INDEX_TTL_MS,
      });
    }
    return index;
  } catch (error: unknown) {
    if (cacheForMetadata.get(key) === pendingEntry) cacheForMetadata.delete(key);
    throw error;
  }
}

function clearCachedJoinTableIndexes(
  metadataCache: MetadataCache,
  connectionName?: string,
): void {
  const cacheForMetadata = cachedJoinTableIndexes.get(metadataCache);
  if (!cacheForMetadata) return;
  if (!connectionName) {
    cacheForMetadata.clear();
    return;
  }
  const prefix = `${connectionName.toUpperCase()}|`;
  for (const key of cacheForMetadata.keys()) {
    if (key.startsWith(prefix)) {
      cacheForMetadata.delete(key);
    }
  }
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

  const normalizedType = inferObjectType(item).toUpperCase();
  const objectType = normalizedType === "SYNONYM"
    ? "synonym"
    : normalizedType === "MATERIALIZED VIEW"
      ? "materialized-view"
      : normalizedType === "VIEW"
        ? "view"
        : "table";
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
      joinReferences: item.joinReferences,
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

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
