import * as vscode from "vscode";
import {
  createConnectedDatabaseConnectionFromDetails,
} from "../../../core/connectedDatabaseFactory";
import type { ConnectionManager } from "../../../core/connectionManager";
import { runQueryRaw, queryResultToRows } from "../../../core/queryRunner";
import type { MetadataCache } from "../../../metadataCache";
import { runWithMetadataQueryConcurrencyLimit } from "../../../metadata/metadataQueryLimiter";
import { Logger } from "../../../utils/logger";
import { escapeSqlString as escapeSqlLiteral } from "../../../utils/sqlUtils";
import {
  createNetezzaCatalogIdentifier,
  createNetezzaUserIdentifier,
  formatNetezzaIdentifier,
} from "./identifierUtils";
import { detectNetezzaSchemasEnabled } from "./schemasOn";

/**
 * The default schema is a tiny `_V_DATABASE` lookup. It must never use the
 * generic query timeout (default: one hour) because DB.. completion would
 * block for that long on a busy connection. The normal path is fully cached
 * (DEFSCHEMA is read with the database list during prefetch); this timeout is
 * only the background recovery path for snapshots created before DEFSCHEMA
 * was persisted.
 */
export const NETEZZA_DEFAULT_SCHEMA_TIMEOUT_SECONDS = 15;

/** Single-flight background default-schema lookups per connection/database. */
const defaultSchemaLookups = new Map<string, Promise<void>>();
const schemaModeLookups = new Map<string, Promise<void>>();

/** Do not retry a failed DEFSCHEMA recovery on every completion request. */
const DEFAULT_SCHEMA_FAILURE_BACKOFF_MS = 60_000;
const defaultSchemaFailedAt = new Map<string, number>();

/**
 * Returns the cached Netezza schema-mode flag. A missing value starts a
 * bounded background probe and returns `undefined` immediately so completion
 * context, hover and diagnostics never wait on `SHOW ENABLE_SCHEMA_DBO_CHECK`.
 */
export async function resolveNetezzaSchemasEnabled(
  connectionName: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  _context: vscode.ExtensionContext,
): Promise<boolean | undefined> {
  const cached = metadataCache.getNetezzaSchemasEnabled(connectionName);
  if (cached !== undefined) {
    return cached;
  }

  scheduleSchemaModeLookup(connectionName, connectionManager, metadataCache);
  return undefined;
}

function scheduleSchemaModeLookup(
  connectionName: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
): void {
  if (schemaModeLookups.has(connectionName)) {
    return;
  }

  const promise = (async (): Promise<void> => {
    let connection: Awaited<ReturnType<typeof createConnectedDatabaseConnectionFromDetails>> | undefined;
    try {
      const details = await connectionManager.getConnection(connectionName);
      if (!details) {
        metadataCache.setNetezzaSchemasEnabled(connectionName, false);
        return;
      }
      connection = await createConnectedDatabaseConnectionFromDetails(details);
      const enabled = await detectNetezzaSchemasEnabled(connection);
      metadataCache.setNetezzaSchemasEnabled(connectionName, enabled);
    } catch (error: unknown) {
      // Preserve the historical fail-safe (treat unknown as schema-less) but
      // do not let a probe failure keep the context request pending.
      metadataCache.setNetezzaSchemasEnabled(connectionName, false);
      Logger.tryGetInstance()?.debug(
        `[NetezzaSchemaContext] Schema-mode detection failed for ${connectionName}`,
        error,
      );
    } finally {
      schemaModeLookups.delete(connectionName);
      try {
        await connection?.close();
      } catch {
        // Best-effort close; the probe result is already committed.
      }
    }
  })();

  schemaModeLookups.set(connectionName, promise);
  void promise;
}

/**
 * Resolve a Netezza database name to its exact catalog spelling using the
 * cached database layer. Falls back to the normalized user identifier when the
 * catalog list is not available.
 */
function resolveCatalogDatabaseName(
  metadataCache: MetadataCache,
  connectionName: string,
  database: string,
): string {
  const requested = createNetezzaUserIdentifier(database);
  const databases = metadataCache.getDatabases(connectionName) ?? [];
  for (const row of databases) {
    const catalogName = String(row.DATABASE || row.label || "").trim();
    if (!catalogName) {
      continue;
    }
    // `requested.value` is folded for unquoted input and exact for quoted
    // input, so the raw catalog spelling must match it byte-for-byte.
    if (catalogName === requested.value) {
      return catalogName;
    }
  }
  return requested.value;
}

/**
 * Recover DEFSCHEMA in the background for snapshots created before the
 * database layer persisted it. This never blocks completion: a cache miss
 * simply falls back to the cached all-schemas list until the value arrives.
 */
function scheduleDefaultSchemaLookup(
  connectionName: string,
  database: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  context: vscode.ExtensionContext,
): void {
  const requested = createNetezzaUserIdentifier(database);
  const lookupKey = JSON.stringify([connectionName, requested.quoted, requested.value]);
  if (defaultSchemaLookups.has(lookupKey)) {
    return;
  }
  const failedAt = defaultSchemaFailedAt.get(lookupKey);
  if (failedAt !== undefined && Date.now() - failedAt < DEFAULT_SCHEMA_FAILURE_BACKOFF_MS) {
    return;
  }

  const promise = (async (): Promise<void> => {
    try {
      const catalogDatabase = resolveCatalogDatabaseName(
        metadataCache,
        connectionName,
        database,
      );
      const sql =
        `SELECT DEFSCHEMA FROM ${formatNetezzaIdentifier(
          createNetezzaCatalogIdentifier(catalogDatabase),
        )}.._V_DATABASE ` +
        `WHERE DATABASE = '${escapeSqlLiteral(catalogDatabase)}'`;

      const result = await runWithMetadataQueryConcurrencyLimit(
        connectionName,
        () => runQueryRaw({
          context,
          query: sql,
          silent: true,
          connectionManager,
          connectionName,
          maxRows: 1,
          isUserQuery: false,
          timeoutSeconds: NETEZZA_DEFAULT_SCHEMA_TIMEOUT_SECONDS,
        }),
      );
      if (!result) {
        defaultSchemaFailedAt.set(lookupKey, Date.now());
        return;
      }

      const rows = queryResultToRows<{ DEFSCHEMA?: string | null }>(result);
      const defaultSchema = typeof rows[0]?.DEFSCHEMA === "string"
        ? rows[0].DEFSCHEMA.trim()
        : "";
      if (!defaultSchema) {
        defaultSchemaFailedAt.set(lookupKey, Date.now());
        return;
      }

      defaultSchemaFailedAt.delete(lookupKey);
      metadataCache.setDefaultSchema(connectionName, database, defaultSchema);
      metadataCache.setDefaultSchema(connectionName, catalogDatabase, defaultSchema);
      Logger.tryGetInstance()?.debug(
        `[NetezzaSchemaContext] Cached default schema ${defaultSchema} for ${connectionName}/${catalogDatabase}`,
      );
    } catch (error: unknown) {
      defaultSchemaFailedAt.set(lookupKey, Date.now());
      Logger.tryGetInstance()?.debug(
        `[NetezzaSchemaContext] Default-schema lookup failed for ${connectionName}/${database}`,
        error,
      );
    } finally {
      defaultSchemaLookups.delete(lookupKey);
    }
  })();

  defaultSchemaLookups.set(lookupKey, promise);
  void promise;
}

/**
 * Returns the default schema (DEFSCHEMA) for a Netezza database.
 *
 * The database layer captured by prefetch is authoritative. A missing value is
 * never turned into a fabricated `ADMIN` cache entry: callers can then fall
 * back to the cached DB.. object list, and a bounded background query fills
 * the value for the next completion request.
 */
export async function resolveNetezzaDefaultSchema(
  connectionName: string,
  database: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const cached = metadataCache.getDefaultSchema(connectionName, database);
  if (cached) {
    return cached;
  }

  scheduleDefaultSchemaLookup(
    connectionName,
    database,
    connectionManager,
    metadataCache,
    context,
  );
  return undefined;
}

/** @internal Test helper */
export function resetNetezzaDefaultSchemaLookupsForTests(): void {
  defaultSchemaLookups.clear();
  schemaModeLookups.clear();
  defaultSchemaFailedAt.clear();
}
