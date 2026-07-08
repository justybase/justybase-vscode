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

export type EditDataPanelInboundMessage = EditDataPanelWebviewToHostMessage;
export type EditDataPanelOutboundMessage = EditDataPanelHostToWebviewMessage;

export const EDIT_DATA_PANEL_WEBVIEW_TO_HOST_COMMANDS = [
    'refresh',
    'save',
    'updateTableComment',
    'updateColumnComment',
    'addColumn',
    'dropColumn',
    'error',
    'info'
] as const satisfies readonly EditDataPanelWebviewToHostMessage['command'][];

export const EDIT_DATA_PANEL_HOST_TO_WEBVIEW_COMMANDS = [
    'setLoading',
    'setData',
    'setError'
] as const satisfies readonly EditDataPanelHostToWebviewMessage['command'][];

export const EDIT_DATA_PANEL_INBOUND_COMMANDS = EDIT_DATA_PANEL_WEBVIEW_TO_HOST_COMMANDS;
export const EDIT_DATA_PANEL_OUTBOUND_COMMANDS = EDIT_DATA_PANEL_HOST_TO_WEBVIEW_COMMANDS;