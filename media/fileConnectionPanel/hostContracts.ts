/**
 * Media-side copy of src/contracts/webviews/fileConnectionPanelContracts.ts.
 * Keep in sync with the host contract file (see webviewContractSync.test.ts).
 */
export type FileConnectionPanelMode = 'dataWorkspace';

export interface FileConnectionPanelWorkspaceSource {
    id: string;
    kind: 'file' | 'external';
    label: string;
    tableName: string;
    rowCount?: number;
    lastRefresh?: string;
    refreshStatus: 'success' | 'error' | 'cancelled' | 'never';
    message?: string;
}

export interface FileConnectionPanelState {
    connections: string[];
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
