declare module 'mssql' {
    export interface config {
        server: string;
        port?: number;
        database?: string;
        user?: string;
        password?: string;
        domain?: string;
        options?: {
            encrypt?: boolean;
            trustServerCertificate?: boolean;
            connectTimeout?: number;
            appName?: string;
        };
        requestTimeout?: number;
    }

    export interface IColumnMetadata {
        index: number;
        name: string;
        length: number;
        type: { name?: string } | (() => { name?: string });
        udt?: unknown;
        scale?: number;
        precision?: number;
        nullable: boolean;
        caseSensitive: boolean;
        identity: boolean;
        readOnly: boolean;
    }

    export interface IRecordSet<T> extends Array<T> {
        columns?: Record<string, { type?: { name?: string } }>;
    }

    export interface IResult<T> {
        recordsets: IRecordSet<T>[];
        recordset: IRecordSet<T>;
        rowsAffected: number[];
    }

    export class Request {
        public stream: boolean;
        public cancel(): void;
        public pause(): boolean;
        public resume(): boolean;
        public query<T = Record<string, unknown>>(command: string): Promise<IResult<T>>;
        public on(event: 'recordset', listener: (columns: Record<string, IColumnMetadata>) => void): this;
        public on(event: 'row', listener: (row: Record<string, unknown>) => void): this;
        public on(event: 'error', listener: (error: Error) => void): this;
        public on(event: 'done', listener: (result: { rowsAffected: number[] }) => void): this;
        public removeAllListeners(event?: string): this;
    }

    export class ConnectionPool {
        public constructor(config: config);
        public connect(): Promise<ConnectionPool>;
        public close(): Promise<void>;
        public request(): Request;
        public on(event: string, listener: (arg: unknown) => void): this;
    }
}
