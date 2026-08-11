export type FileConnectionPanelMode = 'single' | 'workspace';

export interface FileConnectionPanelFile {
    path: string;
    name: string;
    format: 'csv' | 'tsv' | 'parquet' | 'avro' | 'xlsx' | undefined;
    sizeLabel: string;
    exists: boolean;
}

export interface FileConnectionPanelState {
    /** All saved file connection profiles (for the switcher dropdown). */
    connections: string[];
    /** Connection currently selected in the panel. */
    selectedConnectionName: string;
    mode: FileConnectionPanelMode | undefined;
    editable: boolean;
    files: FileConnectionPanelFile[];
    notice?: string;
}

export type FileConnectionPanelWebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'selectConnection'; connectionName: string }
    | { type: 'addFiles'; paths: string[] }
    | { type: 'removeFile'; path: string }
    | { type: 'setEditable'; enabled: boolean }
    | { type: 'deleteConnection' }
    | { type: 'previewFile'; path: string }
    | { type: 'requestSheets'; path: string }
    | { type: 'queryFile'; path: string }
    | { type: 'resolveDroppedNames'; names: string[] }
    | { type: 'exportConnections' }
    | { type: 'importConnections' }
    | { type: 'refresh' };

export type FileConnectionPanelHostToWebviewMessage =
    | { type: 'state'; state: FileConnectionPanelState }
    | { type: 'sheets'; path: string; sheetNames: string[] }
    | { type: 'error'; message: string }
    | { type: 'notice'; message: string };

export const FILE_CONNECTION_PANEL_WEBVIEW_TO_HOST_TYPES = [
    'ready',
    'selectConnection',
    'addFiles',
    'removeFile',
    'setEditable',
    'deleteConnection',
    'previewFile',
    'requestSheets',
    'queryFile',
    'resolveDroppedNames',
    'exportConnections',
    'importConnections',
    'refresh',
] as const satisfies readonly FileConnectionPanelWebviewToHostMessage['type'][];

export const FILE_CONNECTION_PANEL_HOST_TO_WEBVIEW_TYPES = [
    'state',
    'sheets',
    'error',
    'notice',
] as const satisfies readonly FileConnectionPanelHostToWebviewMessage['type'][];

export const FILE_CONNECTION_PANEL_INBOUND_TYPES = FILE_CONNECTION_PANEL_WEBVIEW_TO_HOST_TYPES;
export const FILE_CONNECTION_PANEL_OUTBOUND_TYPES = FILE_CONNECTION_PANEL_HOST_TO_WEBVIEW_TYPES;
