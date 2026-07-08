import type { DatabaseConnectionOptions } from './connectionForm';

export interface DatabaseConnectionConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password?: string;
  options?: DatabaseConnectionOptions;
}

export interface DatabaseDataReader {
  read(): Promise<boolean>;
  nextResult(): Promise<boolean>;
  close(): Promise<void>;
  fieldCount: number;
  getName(index: number): string;
  getTypeName(index: number): string;
  getValue(index: number): unknown;
  getSchemaTable?(): { Rows?: { NumericScale?: number }[] } | { NumericScale?: number }[];
}

export interface DatabaseCommand {
  commandTimeout: number;
  executeReader(): Promise<DatabaseDataReader>;
  cancel(): Promise<void>;
  execute(): Promise<void>;
  _recordsAffected: number;
}

export interface DatabaseConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  createCommand(sql: string): DatabaseCommand;
  on(event: string, listener: (arg: unknown) => void): void;
  removeListener(event: string, listener: (arg: unknown) => void): void;
  _connected?: boolean;
}

export interface DatabaseConnectionConstructor {
  new (config: DatabaseConnectionConfig): DatabaseConnection;
}

export interface DatabaseConnectionStaticConstructor extends DatabaseConnectionConstructor {
  registerImportStream?(name: string, stream: unknown): void;
  unregisterImportStream?(name: string): void;
}
