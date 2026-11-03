/**
 * Webview-local copies of edit data panel message contracts.
 */

export interface EditDataColumnMetadata {
    ATTNAME: string;
    FORMAT_TYPE: string;
    IS_NOT_NULL: number | string | boolean;
    COLDEFAULT: string | null;
    DESCRIPTION: string;
    IS_PK: number | string | boolean;
    IS_FK: number | string | boolean;
    [key: string]: unknown;
}

export interface EditDataMetadata {
    tableComment: string;
    columns: EditDataColumnMetadata[];
}

export interface EditDataRow {
    ROWID?: string | number | null;
    __tempId?: number;
    [key: string]: unknown;
}

/** Load details shown in the panel status bar. */
export interface EditDataLoadInfo {
    rowLimit: number;
    elapsedMs: number;
    tableName: string;
    connectionName: string;
}

export interface EditDataChanges {
    updates?: { rowId: string | number; changes: Record<string, unknown> }[];
    deletes?: (string | number)[];
    inserts?: Record<string, unknown>[];
}

export type EditDataPanelWebviewToHostMessage =
    | { command: 'refresh'; whereClause?: string; columns?: string; orderBy?: string }
    | {
          command: 'save';
          changes: EditDataChanges;
          whereClause?: string;
          columns?: string;
          orderBy?: string;
      }
    | { command: 'updateTableComment'; comment: string }
    | { command: 'updateColumnComment'; column: string; comment: string }
    | { command: 'addColumn'; name: string; type: string }
    | { command: 'dropColumn'; column: string }
    | { command: 'previewSql'; changes: EditDataChanges }
    | { command: 'requestDdl' }
    | { command: 'openSqlInEditor'; sql: string }
    | { command: 'copyText'; text: string }
    | { command: 'closePanel' }
    | { command: 'error'; text: string }
    | { command: 'info'; text: string };

export type EditDataPanelHostToWebviewMessage =
    | { command: 'setLoading'; loading: boolean; message?: string }
    | {
          command: 'setData';
          data: EditDataRow[];
          columns: string[];
          metadata: EditDataMetadata | null;
          info?: EditDataLoadInfo;
      }
    | { command: 'setError'; text: string }
    | { command: 'saveFailed'; text: string }
    | { command: 'sqlPreview'; statements: string[]; error?: string }
    | { command: 'setDdl'; ddl?: string; error?: string };
