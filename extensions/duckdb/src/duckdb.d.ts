declare module '@duckdb/node-api' {
    export interface DuckDBType {
        toString(): string;
    }

    export interface DuckDBMaterializedResult {
        readonly rowsChanged: number;
    }

    export class DuckDBResultReader {
        readonly rowsChanged: number;
        readonly columnCount: number;
        columnName(columnIndex: number): string;
        columnType(columnIndex: number): DuckDBType;
        getRowsJS(): unknown[][];
        getRowObjectsJS(): Record<string, unknown>[];
    }

    export class DuckDBConnection {
        closeSync(): void;
        disconnectSync(): void;
        interrupt(): void;
        run(sql: string): Promise<DuckDBMaterializedResult>;
        runAndReadAll(sql: string): Promise<DuckDBResultReader>;
    }

    export class DuckDBInstance {
        static create(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
        static fromCache(path?: string, options?: Record<string, string>): Promise<DuckDBInstance>;
        connect(): Promise<DuckDBConnection>;
        closeSync(): void;
    }
}
