import {
  DatabaseAdvancedFeatures,
  DatabaseCapabilities,
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseConnectionStaticConstructor,
  DatabaseCopilotReferenceProvider,
  DatabaseDdlProvider,
  DatabaseDialect,
  DatabaseImportTypeMapper,
  DatabaseMaintenanceProvider,
  DatabaseMetadataProvider,
  DatabaseKind,
  DatabaseTunnelConfig,
  DatabaseTuningAdvisor,
  createDatabaseCapabilities,
  DATABASE_KIND_DISPLAY_NAMES,
  normalizeDatabaseKind,
} from "../contracts/database";
import type { DatabaseTunnelRuntime } from './databaseTunnel';
import { ensureBuiltInDialectsRegistered } from "../dialects";
import {
  getDatabaseDialectByKind,
  listRegisteredDatabaseDialects,
} from "./factories/databaseDialectRegistry";
import {
  getDatabaseSqlAuthoring as getRegisteredDatabaseSqlAuthoring,
  tryGetDatabaseSqlAuthoring as tryGetRegisteredDatabaseSqlAuthoring,
} from "./sqlAuthoringRegistry";

const BUILTIN_DIALECTS = new Set<DatabaseKind>(["netezza", "sqlite"]);
const OPTIONAL_EXTENSION_NAMES: Readonly<Partial<Record<DatabaseKind, string>>> = {
  db2: "JustyBase SQL Editor (Db2)",
  duckdb: "JustyBase SQL Editor (DuckDB)",
  file: "JustyBase SQL Editor (DuckDB + Files)",
  oracle: "JustyBase SQL Editor (Oracle)",
  postgresql: "JustyBase SQL Editor (PostgreSQL)",
  vertica: "JustyBase SQL Editor (Vertica)",
  snowflake: "JustyBase SQL Editor (Snowflake)",
  mssql: "JustyBase SQL Editor (MS SQL Server)",
  mysql: "JustyBase SQL Editor (MySQL)",
  clickhouse: "JustyBase SQL Editor (ClickHouse)",
  access: "JustyBase SQL Editor (Microsoft Access)",
};

export interface DatabaseConnectionDetails {
  name?: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionConfig["options"];
  dbType?: string | DatabaseKind;
  tunnel?: DatabaseTunnelConfig;
}

export interface DatabaseConnectionOpenOptions {
  /** Temporary token used by the unsaved connection form during Test Connection. */
  tunnelToken?: string;
  /** Prevents Test Connection from falling back to a token already in SecretStorage. */
  clearTunnelToken?: boolean;
}

let databaseTunnelRuntime: DatabaseTunnelRuntime | undefined;

/** Configure the core-owned tunnel runtime once during extension activation. */
export function configureDatabaseTunnelRuntime(runtime: DatabaseTunnelRuntime | undefined): void {
  databaseTunnelRuntime = runtime;
}

function createInstallHint(kind: DatabaseKind): string {
  const connectionDisplayName = DATABASE_KIND_DISPLAY_NAMES[kind] ?? kind;
  const extensionDisplayName =
    OPTIONAL_EXTENSION_NAMES[kind] ?? DATABASE_KIND_DISPLAY_NAMES[kind] ?? kind;
  return `Install the optional "${extensionDisplayName}" extension to use ${connectionDisplayName} connections.`;
}

export function resolveConnectionDatabaseKind(
  kind?: string | DatabaseKind,
): DatabaseKind {
  return normalizeDatabaseKind(kind);
}

function getRegisteredDatabaseDialect(
  kind?: string | DatabaseKind,
): DatabaseDialect | undefined {
  ensureBuiltInDialectsRegistered();
  return getDatabaseDialectByKind(resolveConnectionDatabaseKind(kind));
}

function createMissingDialectError(kind: DatabaseKind): Error {
  const baseMessage = `No database dialect registered for '${kind}'`;
  if (BUILTIN_DIALECTS.has(kind)) {
    return new Error(baseMessage);
  }
  const installHint = createInstallHint(kind);
  return new Error(`${baseMessage}. ${installHint}`);
}

export function tryGetDatabaseDialect(
  kind?: string | DatabaseKind,
): DatabaseDialect | undefined {
  const normalizedKind = resolveConnectionDatabaseKind(kind);
  return getRegisteredDatabaseDialect(normalizedKind);
}

export function getDatabaseDialect(
  kind?: string | DatabaseKind,
): DatabaseDialect {
  const normalizedKind = resolveConnectionDatabaseKind(kind);
  const dialect = getRegisteredDatabaseDialect(normalizedKind);
  if (!dialect) {
    throw createMissingDialectError(normalizedKind);
  }
  return dialect;
}

export function createDatabaseConnection(
  config: DatabaseConnectionConfig,
  kind?: string | DatabaseKind,
): DatabaseConnection {
  return getDatabaseDialect(kind).createConnection(config);
}

export function getDatabaseConnectionConstructor(
  kind?: string | DatabaseKind,
): DatabaseConnectionStaticConstructor {
  return getDatabaseDialect(kind).getConnectionConstructor();
}

export function createDatabaseConnectionFromDetails(details: DatabaseConnectionDetails): DatabaseConnection {
  if (details.tunnel) {
    throw new Error(
      'This connection uses a TCP tunnel. Use createConnectedDatabaseConnectionFromDetails so the tunnel can start asynchronously.',
    );
  }
  const dialect = getDatabaseDialect(details.dbType);
  return createDatabaseConnection(buildDatabaseConnectionConfig(details, dialect), details.dbType);
}

export function getDatabaseCapabilities(
  kind?: string | DatabaseKind,
): DatabaseCapabilities {
  const normalizedKind = resolveConnectionDatabaseKind(kind);
  const dialect = getRegisteredDatabaseDialect(normalizedKind);
  return dialect?.capabilities ?? createDatabaseCapabilities();
}

export function getDatabaseMetadataProvider(
  kind?: string | DatabaseKind,
): DatabaseMetadataProvider {
  return getDatabaseDialect(kind).metadataProvider;
}

export function tryGetDatabaseSqlAuthoring(kind?: string | DatabaseKind) {
  return tryGetRegisteredDatabaseSqlAuthoring(kind);
}

export function getDatabaseSqlAuthoring(kind?: string | DatabaseKind) {
  return getRegisteredDatabaseSqlAuthoring(kind);
}

export function getRegisteredDatabaseDialects(): readonly DatabaseDialect[] {
  ensureBuiltInDialectsRegistered();
  return listRegisteredDatabaseDialects();
}

export async function createConnectedDatabaseConnectionFromDetails(
  details: DatabaseConnectionDetails,
  databaseOverride?: string,
  openOptions: DatabaseConnectionOpenOptions = {},
): Promise<DatabaseConnection> {
  const dialect = getDatabaseDialect(details.dbType);
  const endpoint = await resolveTunnelEndpoint(
    details,
    dialect,
    openOptions.tunnelToken,
    openOptions.clearTunnelToken,
  );
  const connection = createDatabaseConnection(
    buildDatabaseConnectionConfig(details, dialect, databaseOverride, endpoint),
    details.dbType,
  );
  try {
    await connection.connect();
    return connection;
  } catch (error: unknown) {
    try {
      await connection.close();
    } catch {
      // Ignore cleanup errors and rethrow the original connection failure.
    }
    throw error;
  }
}

function buildDatabaseConnectionConfig(
  details: DatabaseConnectionDetails,
  dialect: DatabaseDialect,
  databaseOverride?: string,
  endpoint?: { host: string; port: number },
): DatabaseConnectionConfig {
  return {
    host: endpoint?.host ?? details.host,
    port: endpoint?.port ?? details.port ?? dialect.defaultPort,
    database: databaseOverride ?? details.database,
    user: details.user,
    password: details.password,
    options: details.options,
  };
}

async function resolveTunnelEndpoint(
  details: DatabaseConnectionDetails,
  dialect: DatabaseDialect,
  tokenOverride?: string,
  clearStoredToken = false,
): Promise<{ host: string; port: number } | undefined> {
  if (!details.tunnel) return undefined;
  if (!dialect.supportsRawTcpTunnel) {
    throw new Error(`Database dialect '${dialect.displayName}' does not support transparent TCP tunnels.`);
  }
  if (dialect.kind === 'oracle' && typeof details.options?.connectString === 'string' && details.options.connectString.trim()) {
    throw new Error(
      'Oracle TCP tunnels require Host, Port and Service Name. Connect String Override is not supported with a tunnel.',
    );
  }
  if (!databaseTunnelRuntime) {
    throw new Error('The core database tunnel runtime is not initialized. Reload the VS Code window and try again.');
  }

  const token = clearStoredToken
    ? tokenOverride?.trim()
    : tokenOverride?.trim() || await databaseTunnelRuntime.getToken(details.tunnel.id);
  if (!token) {
    throw new Error(`No token is configured for database tunnel '${details.tunnel.id}'.`);
  }
  return await databaseTunnelRuntime.ensureStarted(details.tunnel, token, details.name);
}

export async function executeDatabaseQuery<T = Record<string, unknown>>(
  connection: DatabaseConnection,
  sql: string,
): Promise<T[]> {
  const cmd = connection.createCommand(sql);
  const reader = await cmd.executeReader();
  const results: Record<string, unknown>[] = [];

  try {
    while (await reader.read()) {
      const row: Record<string, unknown> = {};
      for (let i = 0; i < reader.fieldCount; i++) {
        row[reader.getName(i)] = reader.getValue(i);
      }
      results.push(row);
    }
    return results as T[];
  } finally {
    await reader.close();
  }
}

export function getDatabaseAdvancedFeatures(
  kind?: string | DatabaseKind,
): DatabaseAdvancedFeatures | undefined {
  return getDatabaseDialect(kind).advancedFeatures;
}

export function getDatabaseDdlProvider(
  kind?: string | DatabaseKind,
): DatabaseDdlProvider | undefined {
  return getDatabaseAdvancedFeatures(kind)?.ddl;
}

export function getRequiredDatabaseDdlProvider(
  kind?: string | DatabaseKind,
): DatabaseDdlProvider {
  const provider = getDatabaseDdlProvider(kind);
  if (!provider) {
    const dialect = getDatabaseDialect(kind);
    throw new Error(
      `Database dialect "${dialect.displayName}" does not provide DDL features.`,
    );
  }
  return provider;
}

export function getDatabaseImportTypeMapper(
  kind?: string | DatabaseKind,
): DatabaseImportTypeMapper | undefined {
  return getDatabaseAdvancedFeatures(kind)?.importTypeMapper;
}

export function getRequiredDatabaseImportTypeMapper(
  kind?: string | DatabaseKind,
): DatabaseImportTypeMapper {
  const mapper = getDatabaseImportTypeMapper(kind);
  if (!mapper) {
    const dialect = getDatabaseDialect(kind);
    throw new Error(
      `Database dialect "${dialect.displayName}" does not provide import type mapping features.`,
    );
  }
  return mapper;
}

export function getDatabaseTuningAdvisor(
  kind?: string | DatabaseKind,
): DatabaseTuningAdvisor | undefined {
  return getDatabaseAdvancedFeatures(kind)?.tuningAdvisor;
}

export function getDatabaseMaintenanceProvider(
  kind?: string | DatabaseKind,
): DatabaseMaintenanceProvider | undefined {
  return getDatabaseAdvancedFeatures(kind)?.maintenance;
}

export function getRequiredDatabaseTuningAdvisor(
  kind?: string | DatabaseKind,
): DatabaseTuningAdvisor {
  const advisor = getDatabaseTuningAdvisor(kind);
  if (!advisor) {
    const dialect = getDatabaseDialect(kind);
    throw new Error(
      `Database dialect "${dialect.displayName}" does not provide tuning advice features.`,
    );
  }
  return advisor;
}

export function getDatabaseCopilotReferenceProvider(
  kind?: string | DatabaseKind,
): DatabaseCopilotReferenceProvider | undefined {
  return getDatabaseAdvancedFeatures(kind)?.copilotReferenceProvider;
}

export function getRequiredDatabaseCopilotReferenceProvider(
  kind?: string | DatabaseKind,
): DatabaseCopilotReferenceProvider {
  const provider = getDatabaseCopilotReferenceProvider(kind);
  if (!provider) {
    const dialect = getDatabaseDialect(kind);
    throw new Error(
      `Database dialect "${dialect.displayName}" does not provide Copilot reference features.`,
    );
  }
  return provider;
}
