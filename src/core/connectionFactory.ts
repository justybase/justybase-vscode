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
  DatabaseTuningAdvisor,
  createDatabaseCapabilities,
  DATABASE_KIND_DISPLAY_NAMES,
  normalizeDatabaseKind,
} from "../contracts/database";
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

function createInstallHint(kind: DatabaseKind): string {
  const displayName = DATABASE_KIND_DISPLAY_NAMES[kind] ?? kind;
  return `Install the optional "JustyBase ${displayName} Support" extension to use ${displayName} connections.`;
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

export function createDatabaseConnectionFromDetails(details: {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionConfig["options"];
  dbType?: string | DatabaseKind;
}): DatabaseConnection {
  const dialect = getDatabaseDialect(details.dbType);
  return createDatabaseConnection(
    {
      host: details.host,
      port: details.port ?? dialect.defaultPort,
      database: details.database,
      user: details.user,
      password: details.password,
      options: details.options,
    },
    details.dbType,
  );
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
  details: {
    host: string;
    port?: number;
    database: string;
    user: string;
    password?: string;
    options?: DatabaseConnectionConfig["options"];
    dbType?: string | DatabaseKind;
  },
  databaseOverride?: string,
): Promise<DatabaseConnection> {
  const dialect = getDatabaseDialect(details.dbType);
  const connection = createDatabaseConnection(
    {
      host: details.host,
      port: details.port ?? dialect.defaultPort,
      database: databaseOverride ?? details.database,
      user: details.user,
      password: details.password,
      options: details.options,
    },
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
