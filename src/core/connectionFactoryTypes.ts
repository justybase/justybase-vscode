import type {
  DatabaseConnectionConfig,
  DatabaseKind,
  DatabaseTunnelConfig,
} from '../contracts/database';

export interface DatabaseConnectionDetails {
  name?: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionConfig['options'];
  dbType?: string | DatabaseKind;
  tunnel?: DatabaseTunnelConfig;
}

export interface DatabaseConnectionOpenOptions {
  /** Temporary token used by the unsaved connection form during Test Connection. */
  tunnelToken?: string;
  /** Prevents Test Connection from falling back to a token already in SecretStorage. */
  clearTunnelToken?: boolean;
}
