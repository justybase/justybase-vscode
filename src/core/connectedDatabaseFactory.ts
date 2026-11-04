import {
  DatabaseConnection,
  DatabaseConnectionConfig,
  DatabaseDialect,
  DatabaseKind,
  normalizeDatabaseKind,
} from '../contracts/database';
import type { DatabaseTunnelEndpoint, DatabaseTunnelRuntime } from './databaseTunnel';
import {
  getDatabaseDialectByKind,
} from './factories/databaseDialectRegistry';
import type {
  DatabaseConnectionDetails,
  DatabaseConnectionOpenOptions,
} from './connectionFactoryTypes';

let databaseTunnelRuntime: DatabaseTunnelRuntime | undefined;

/** Configure the core-owned tunnel runtime once during extension activation. */
export function configureDatabaseTunnelRuntime(runtime: DatabaseTunnelRuntime | undefined): void {
  databaseTunnelRuntime = runtime;
}

function getDialect(kind?: string | DatabaseKind): DatabaseDialect {
  const normalizedKind = normalizeDatabaseKind(kind);
  const dialect = getDatabaseDialectByKind(normalizedKind);
  if (!dialect) {
    throw new Error(`No database dialect registered for '${normalizedKind}'`);
  }
  return dialect;
}

function buildDatabaseConnectionConfig(
  details: DatabaseConnectionDetails,
  dialect: DatabaseDialect,
  databaseOverride?: string,
  endpoint?: DatabaseTunnelEndpoint,
): DatabaseConnectionConfig {
  return {
    host: endpoint?.host ?? details.host,
    port: endpoint?.port ?? details.port ?? dialect.defaultPort,
    database: databaseOverride ?? details.database,
    user: details.user,
    // With service login the driver only proves it owns this tunnel. The relay
    // answers the database password challenge, and the service password stays
    // with the tunnel, so it can never be sent to a database.
    password: endpoint?.clientProof ?? details.password,
    options: details.options,
  };
}

async function resolveTunnelEndpoint(
  details: DatabaseConnectionDetails,
  dialect: DatabaseDialect,
  tokenOverride?: string,
  clearStoredToken = false,
): Promise<DatabaseTunnelEndpoint | undefined> {
  if (!details.tunnel) return undefined;
  if (!dialect.supportsRawTcpTunnel) {
    throw new Error(`Database dialect '${dialect.displayName}' does not support transparent TCP tunnels.`);
  }
  const usesServiceLogin = details.tunnel.auth === 'service-login';
  if (usesServiceLogin && !dialect.supportsTunnelServiceLogin) {
    throw new Error(`Database dialect '${dialect.displayName}' does not support service login through a tunnel.`);
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
  return databaseTunnelRuntime.ensureStarted(
    details.tunnel,
    token,
    details.name,
    usesServiceLogin ? details.user : undefined,
  );
}

export async function createConnectedDatabaseConnectionFromDetails(
  details: DatabaseConnectionDetails,
  databaseOverride?: string,
  openOptions: DatabaseConnectionOpenOptions = {},
): Promise<DatabaseConnection> {
  const dialect = getDialect(details.dbType);
  const endpoint = await resolveTunnelEndpoint(
    details,
    dialect,
    openOptions.tunnelToken,
    openOptions.clearTunnelToken,
  );
  const connection = dialect.createConnection(
    buildDatabaseConnectionConfig(details, dialect, databaseOverride, endpoint),
  );
  try {
    await connection.connect();
    return connection;
  } catch (error: unknown) {
    try {
      await connection.close();
    } catch {
      // Preserve the original connection failure if cleanup also fails.
    }
    throw error;
  }
}
