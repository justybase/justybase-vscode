declare module 'ibm_db' {
    export interface OpenOptions {
        connectTimeout?: number;
    }

    export interface Column {
        SQL_DESC_NAME?: string;
        SQL_DESC_TYPE_NAME?: string;
        SQL_DESC_CONSIZE_TYPE?: number;
        SQL_DESC_DISPLAY_SIZE?: number;
        SQL_DESC_PRECISION?: number;
        SQL_DESC_SCALE?: number;
        SQL_DESC_LENGTH?: number;
    }

    export interface OdbcColumnMetadata extends Column {
        SQL_DESC_TYPE?: string | number;
        NAME?: string;
        TYPE_NAME?: string;
    }

    export interface ODBCResult {
        fetch(options?: unknown): Promise<Record<string, unknown> | unknown[] | null>;
        fetchAllSync(options?: unknown): unknown[];
        getColumnMetadataSync(): Column[];
        getColumnNamesSync(): string[];
        close(callback?: (error?: Error | null) => void): Promise<unknown> | void;
        closeSync(): boolean | void;
    }

    export type OdbcResult = ODBCResult;

    export interface Database {
        query(sqlQuery: string, bindingParameters?: readonly unknown[]): Promise<unknown>;
        queryResult(
            sqlQuery: string,
            bindingParameters?: readonly unknown[]
        ): Promise<[ODBCResult | null, unknown[]]>;
        querySync(sqlQuery: string, bindingParameters?: readonly unknown[]): unknown;
        queryResultSync(
            sqlQuery: string,
            bindingParameters?: readonly unknown[]
        ): ODBCResult | [ODBCResult | null, unknown[]] | null;
        close(callback?: (error?: Error | null) => void): Promise<void> | void;
        closeSync(): void;
    }

    export function open(
        connectionString: string,
        options?: OpenOptions
    ): Promise<Database>;
    export function openSync(connectionString: string, options?: OpenOptions): Database;
}
