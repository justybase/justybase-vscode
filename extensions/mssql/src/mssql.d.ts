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

    export interface IRecordSet<T> extends Array<T> {
        columns?: Record<string, { type?: { name?: string } }>;
    }

    export interface IResult<T> {
        recordsets: IRecordSet<T>[];
        recordset: IRecordSet<T>;
        rowsAffected: number[];
    }

    export class Request {
        public cancel(): void;
        public query<T = Record<string, unknown>>(command: string): Promise<IResult<T>>;
    }

    export class ConnectionPool {
        public constructor(config: config);
        public connect(): Promise<ConnectionPool>;
        public close(): Promise<void>;
        public request(): Request;
        public on(event: string, listener: (arg: unknown) => void): this;
    }
}
