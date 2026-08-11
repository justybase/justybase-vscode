/**
 * Media-side copy of src/contracts/webviews/fileConnectionPanelContracts.ts.
 * Keep in sync with the host contract file (see webviewContractSync.test.ts).
 */
export type FileConnectionPanelMode = 'single' | 'workspace';

export interface FileConnectionPanelFile {
    path: string;
    name: string;
    format: 'csv' | 'tsv' | 'parquet' | 'avro' | 'xlsx' | undefined;
    sizeLabel: string;
    exists: boolean;
}

export interface FileConnectionPanelState {
    connections: string[];
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
