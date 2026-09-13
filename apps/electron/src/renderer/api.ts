import {
  createApiClient as createSharedApiClient,
} from '@justybase/api-client';
import type { WorkspaceApi } from '@justybase/api-client';

export type { QueryEventSubscription } from '@justybase/api-client';
export { ApiRequestError, parseQueryEvent } from '@justybase/api-client';

export type ElectronApiClient = Pick<WorkspaceApi,
  'startQuery'
  | 'queryPage'
  | 'cancelQuery'
  | 'exportQuery'
  | 'connectToQueryEvents'>;

/** Renderer-visible workspace surface; authentication/admin remain main-owned. */
export type ElectronWorkspaceApi = ElectronApiClient & Pick<WorkspaceApi,
  'databases'
  | 'schemas'
  | 'objects'
  | 'columns'
  | 'ddl'
  | 'designerCapabilities'
  | 'designerSnapshot'
  | 'history'
  | 'audit'
  | 'previewQuery'
  | 'editPreview'
  | 'edit'
  | 'importPreview'
  | 'importRows'
  | 'importFilePreview'
  | 'importFile'
  | 'aggregate'
  | 'group'
  | 'editorPreferences'
  | 'updateEditorPreferences'
  | 'schemaTree'
  | 'searchSchema'
  | 'completion'
  | 'diagnostics'
  | 'formatSql'
  | 'snippets'
  | 'openWebSocket'>;

export interface ElectronApiClientOptions {
  readonly fetcher?: typeof globalThis.fetch;
  readonly WebSocket?: new (url: string) => WebSocket;
}

/** Electron configures the shared transport for its authenticated same-origin shell. */
export function createElectronApiClient(options: ElectronApiClientOptions = {}): ElectronWorkspaceApi {
  const client = createSharedApiClient({
    fetch: options.fetcher,
    credentials: 'same-origin',
    exportFilePrefix: 'justybase-result',
    WebSocket: options.WebSocket,
    errorMessages: {
      request: 'Electron API request failed.',
      download: 'Electron export failed.',
      fetchUnavailable: 'Fetch is unavailable in the Electron renderer.',
      websocketUnavailable: 'WebSocket is unavailable in the Electron renderer.',
      streamDisconnected: 'Electron query stream disconnected after five reconnect attempts.',
    },
  });
  return {
    startQuery: client.startQuery,
    queryPage: client.queryPage,
    cancelQuery: client.cancelQuery,
    exportQuery: client.exportQuery,
    connectToQueryEvents: client.connectToQueryEvents,
    databases: client.databases,
    schemas: client.schemas,
    objects: client.objects,
    columns: client.columns,
    ddl: client.ddl,
    designerCapabilities: client.designerCapabilities,
    designerSnapshot: client.designerSnapshot,
    history: client.history,
    audit: client.audit,
    previewQuery: client.previewQuery,
    editPreview: client.editPreview,
    edit: client.edit,
    importPreview: client.importPreview,
    importRows: client.importRows,
    importFilePreview: client.importFilePreview,
    importFile: client.importFile,
    aggregate: client.aggregate,
    group: client.group,
    editorPreferences: client.editorPreferences,
    updateEditorPreferences: client.updateEditorPreferences,
    schemaTree: client.schemaTree,
    searchSchema: client.searchSchema,
    completion: client.completion,
    diagnostics: client.diagnostics,
    formatSql: client.formatSql,
    snippets: client.snippets,
    openWebSocket: client.openWebSocket,
  };
}
