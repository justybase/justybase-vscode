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

export type EditDataObjectKind = 'table' | 'view' | 'procedure';

/** Read-only definition row shown for objects that do not expose columns (procedures). */
export interface EditDataProperty {
    label: string;
    value: string;
}

/** Positional procedure argument parsed from the catalog signature. */
export interface EditDataArgument {
    position: number;
    type: string;
}

export interface EditDataMetadata {
    tableComment: string;
    columns: EditDataColumnMetadata[];
    objectKind?: EditDataObjectKind;
    properties?: EditDataProperty[];
    arguments?: EditDataArgument[];
}

/** Where a Structure payload came from: the metadata cache or a fresh catalog read. */
export type EditDataMetadataSource = 'cache' | 'live';

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
    | { command: 'ready' }
    | { command: 'requestData' }
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
          command: 'setMetadata';
          metadata: EditDataMetadata | null;
          readOnly?: boolean;
          source?: EditDataMetadataSource;
          error?: string;
      }
    | {
          command: 'setData';
          data: EditDataRow[];
          columns: string[];
          metadata: EditDataMetadata | null;
          info?: EditDataLoadInfo;
          readOnly?: boolean;
      }
    | { command: 'setError'; text: string }
    | { command: 'saveFailed'; text: string }
    | { command: 'sqlPreview'; statements: string[]; error?: string }
    | { command: 'setDdl'; ddl?: string; error?: string };
