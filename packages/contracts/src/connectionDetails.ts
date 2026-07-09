import type { DatabaseConnectionOptions, DatabaseKind } from './database/index';

export interface ConnectionDetails {
  name?: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionOptions;
  dbType?: DatabaseKind;
  accentColor?: string;
  schema?: string;
}

export type NamedConnectionDetails = ConnectionDetails & { name: string };
