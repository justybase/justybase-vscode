import type { DatabaseConnectionOptions, DatabaseKind } from './database/index';

/**
 * Configuration for a transparent TCP tunnel managed by the desktop core.
 * The bearer token deliberately does not belong to this serializable contract;
 * it is kept in the host's SecretStorage.
 */
export interface DatabaseTunnelConfig {
  /** Stable opaque id used to locate the token in SecretStorage. */
  id: string;
  /** HTTP(S)/WS(S) base URL of the relay. */
  serverUrl: string;
  /** Named, server-side allowlisted TCP target. */
  targetId: string;
  /** Loopback TCP port opened by the desktop client. */
  localPort: number;
}

export interface ConnectionDetails {
  name?: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionOptions;
  dbType?: DatabaseKind;
  tunnel?: DatabaseTunnelConfig;
  accentColor?: string;
  schema?: string;
}

export type NamedConnectionDetails = ConnectionDetails & { name: string };
