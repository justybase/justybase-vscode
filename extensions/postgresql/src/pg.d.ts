declare module "pg" {
  export interface FieldDef {
    name: string;
    dataTypeID: number;
  }

  export interface QueryResult<R = Record<string, unknown> | unknown[]> {
    command?: string;
    rows: R[];
    fields?: FieldDef[];
    rowCount?: number | null;
  }

  export interface QueryConfig {
    text: string;
    values?: unknown[];
    rowMode?: "array";
    queryMode?: string;
  }

  export interface ClientConfig {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    application_name?: string;
  }

  export interface ClientNotice {
    message?: string;
    severity?: string;
  }

  export interface BuiltinTypes {
    [name: string]: number;
  }

  export interface PgTypes {
    builtins?: BuiltinTypes;
  }

  export const types: PgTypes;

  export class Client {
    public constructor(config?: ClientConfig);
    public on(
      event: "notice" | "error" | "end",
      listener: (arg: unknown) => void,
    ): void;
    public connect(): Promise<void>;
    public end(): Promise<void>;
    public query<R = Record<string, unknown> | unknown[]>(
      sql: string,
    ): Promise<QueryResult<R> | QueryResult<R>[]>;
    public query<R = Record<string, unknown> | unknown[]>(
      sql: string,
      values: unknown[],
    ): Promise<QueryResult<R>>;
    public query<R = Record<string, unknown> | unknown[]>(
      config: QueryConfig,
    ): Promise<QueryResult<R> | QueryResult<R>[]>;
  }
}

declare module "pg-protocol" {
  export interface Serializer {
    serialize: (stream: NodeJS.WritableStream) => void;
    copyData: (buffer: Buffer) => Buffer;
    copyDone: () => Buffer;
  }

  export const serialize: Serializer;

  export class DatabaseError extends Error {
    public length: number;
    public name: string;
    public severity: string;
    public code: string;
    public detail?: string;
    public hint?: string;
    public position?: string;
  }
}
