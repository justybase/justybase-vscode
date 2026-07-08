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

export interface EditDataChanges {
    updates?: { rowId: string | number; changes: Record<string, unknown> }[];
    deletes?: (string | number)[];
    inserts?: Record<string, unknown>[];
}

export type EditDataPanelWebviewToHostMessage =
    | { command: 'refresh'; whereClause?: string; columns?: string }
    | {
          command: 'save';
          changes: EditDataChanges;
          whereClause?: string;
          columns?: string;
      }
    | { command: 'updateTableComment'; comment: string }
    | { command: 'updateColumnComment'; column: string; comment: string }
    | { command: 'addColumn'; name: string; type: string }
    | { command: 'dropColumn'; column: string }
    | { command: 'error'; text: string }
    | { command: 'info'; text: string };

export type EditDataPanelHostToWebviewMessage =
    | { command: 'setLoading'; loading: boolean; message?: string }
    | {
          command: 'setData';
          data: EditDataRow[];
          columns: string[];
          metadata: EditDataMetadata | null;
      }
    | { command: 'setError'; text: string };
