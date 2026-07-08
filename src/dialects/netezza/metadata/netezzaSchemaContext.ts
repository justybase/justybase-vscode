import * as vscode from "vscode";
import {
  createConnectedDatabaseConnectionFromDetails,
} from "../../../core/connectionFactory";
import type { ConnectionManager } from "../../../core/connectionManager";
import { runQueryRaw, queryResultToRows } from "../../../core/queryRunner";
import type { MetadataCache } from "../../../metadataCache";
import { detectNetezzaSchemasEnabled } from "./schemasOn";

const DEFAULT_SCHEMA_FALLBACK = "ADMIN";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeDatabaseName(database: string): string {
  return database.replace(/^"|"$/g, "").trim().toUpperCase();
}

/**
 * Returns cached or freshly detected Netezza schema-mode flag for a connection.
 */
export async function resolveNetezzaSchemasEnabled(
  connectionName: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  _context: vscode.ExtensionContext,
): Promise<boolean> {
  const cached = metadataCache.getNetezzaSchemasEnabled(connectionName);
  if (cached !== undefined) {
    return cached;
  }

  const details = await connectionManager.getConnection(connectionName);
  if (!details) {
    return false;
  }

  let enabled;
  const connection = await createConnectedDatabaseConnectionFromDetails(details);
  try {
    enabled = await detectNetezzaSchemasEnabled(connection);
  } catch {
    enabled = false;
  } finally {
    await connection.close();
  }

  metadataCache.setNetezzaSchemasEnabled(connectionName, enabled);
  return enabled;
}

/**
 * Returns the default schema (DEFSCHEMA) for a Netezza database.
 */
export async function resolveNetezzaDefaultSchema(
  connectionName: string,
  database: string,
  connectionManager: ConnectionManager,
  metadataCache: MetadataCache,
  context: vscode.ExtensionContext,
): Promise<string> {
  const normalizedDatabase = normalizeDatabaseName(database);
  const cached = metadataCache.getDefaultSchema(connectionName, normalizedDatabase);
  if (cached) {
    return cached;
  }

  const safeDatabase = normalizedDatabase;
  const escapedDatabaseLiteral = escapeSqlLiteral(safeDatabase);
  const sql =
    `SELECT DEFSCHEMA FROM ${safeDatabase}.._V_DATABASE ` +
    `WHERE DATABASE = '${escapedDatabaseLiteral}'`;

  try {
    const result = await runQueryRaw(
      context,
      sql,
      true,
      connectionManager,
      connectionName,
      undefined,
      undefined,
      undefined,
      1,
      false,
    );
    if (!result) {
      metadataCache.setDefaultSchema(
        connectionName,
        normalizedDatabase,
        DEFAULT_SCHEMA_FALLBACK,
      );
      return DEFAULT_SCHEMA_FALLBACK;
    }

    const rows = queryResultToRows<{ DEFSCHEMA?: string }>(result);
    const schema =
      rows.length > 0 && rows[0].DEFSCHEMA
        ? normalizeDatabaseName(rows[0].DEFSCHEMA)
        : DEFAULT_SCHEMA_FALLBACK;
    metadataCache.setDefaultSchema(connectionName, normalizedDatabase, schema);
    return schema;
  } catch {
    metadataCache.setDefaultSchema(
      connectionName,
      normalizedDatabase,
      DEFAULT_SCHEMA_FALLBACK,
    );
    return DEFAULT_SCHEMA_FALLBACK;
  }
}
