/** The manager intentionally exposes one user-facing workspace variant. */
export type FileConnectionPanelMode = 'dataWorkspace';

export type FileConnectionPanelSourceFormat = 'xlsx' | 'xlsb' | 'csv' | 'tsv' | 'parquet' | 'avro' | 'access';

export interface FileConnectionPanelWorkspaceSource {
    id: string;
    kind: 'file' | 'external';
    label: string;
    tableName: string;
    sourceFormat?: FileConnectionPanelSourceFormat;
    canEditSource: boolean;
    rowCount?: number;
    lastRefresh?: string;
    refreshStatus: 'success' | 'error' | 'cancelled' | 'never';
    message?: string;
}

export interface FileConnectionPanelState {
    /** All saved persistent Data Workspace profiles (for the switcher dropdown). */
    connections: string[];
    /** Connection currently selected in the panel. */
    selectedConnectionName: string;
    mode: FileConnectionPanelMode | undefined;
    workspaceSources?: FileConnectionPanelWorkspaceSource[];
    notice?: string;
}

export type FileConnectionPanelWebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'selectConnection'; connectionName: string }
    | { type: 'createDataWorkspace' }
    | { type: 'addWorkspaceFile' }
    | { type: 'addNetezzaSource' }
    | { type: 'editWorkspaceSource'; sourceId: string }
    | { type: 'refreshWorkspaceSource'; sourceId: string }
    | { type: 'removeWorkspaceSource'; sourceId: string }
    | { type: 'queryWorkspace' }
    | { type: 'deleteConnection' }
    | { type: 'exportConnections' }
    | { type: 'importConnections' }
    | { type: 'refresh' };

export type FileConnectionPanelHostToWebviewMessage =
    | { type: 'state'; state: FileConnectionPanelState }
    | { type: 'error'; message: string }
    | { type: 'notice'; message: string };

export const FILE_CONNECTION_PANEL_WEBVIEW_TO_HOST_TYPES = [
    'ready',
    'selectConnection',
    'createDataWorkspace',
    'addWorkspaceFile',
    'addNetezzaSource',
    'editWorkspaceSource',
    'refreshWorkspaceSource',
    'removeWorkspaceSource',
    'queryWorkspace',
    'deleteConnection',
    'exportConnections',
    'importConnections',
    'refresh',
] as const satisfies readonly FileConnectionPanelWebviewToHostMessage['type'][];

export const FILE_CONNECTION_PANEL_HOST_TO_WEBVIEW_TYPES = [
    'state',
    'error',
    'notice',
] as const satisfies readonly FileConnectionPanelHostToWebviewMessage['type'][];

export const FILE_CONNECTION_PANEL_INBOUND_TYPES = FILE_CONNECTION_PANEL_WEBVIEW_TO_HOST_TYPES;
export const FILE_CONNECTION_PANEL_OUTBOUND_TYPES = FILE_CONNECTION_PANEL_HOST_TO_WEBVIEW_TYPES;
