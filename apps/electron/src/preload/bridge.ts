import type {
  ElectronRendererApi,
  OpaqueCredentialRequestId,
  RedactedConnectionProfile,
  UiAuthState,
  UiCapabilitySnapshot,
} from '@justybase/contracts';
import { isRedactedConnectionProfile, isUiAuthState, isUiCapabilitySnapshot } from '@justybase/contracts';

export interface RendererIpcMessage {
  readonly method: string;
  readonly payload?: unknown;
}

export type IpcInvoker = (message: RendererIpcMessage) => Promise<unknown>;

function failure(value: unknown): never {
  const error = typeof value === 'object' && value !== null ? value as { code?: unknown; message?: unknown } : {};
  throw new Error(typeof error.message === 'string' ? error.message : 'Electron operation failed.');
}

async function invokeResponse(invoke: IpcInvoker, message: RendererIpcMessage): Promise<Record<string, unknown>> {
  const response = await invoke(message);
  if (typeof response !== 'object' || response === null || Array.isArray(response)) throw new Error('Malformed response from Electron main process.');
  const record = response as Record<string, unknown>;
  if (record.ok !== true) failure(record);
  return record;
}

function malformedField(field: string): never {
  throw new Error(`Malformed ${field} from Electron main process.`);
}

/** Allowlisted, renderer-safe API. No raw invoke function is exposed. */
export function createPreloadBridge(invoke: IpcInvoker): ElectronRendererApi {
  return Object.freeze({
    getAuthState: async (): Promise<UiAuthState> => {
      const response = await invokeResponse(invoke, { method: 'auth/status' });
      if (!isUiAuthState(response.auth)) malformedField('auth state');
      return response.auth;
    },
    requestCredential: async (purpose: 'login' | 'connection'): Promise<OpaqueCredentialRequestId> => {
      const response = await invokeResponse(invoke, { method: 'credential/request', payload: { purpose } });
      if (typeof response.requestId !== 'string' || response.requestId.length === 0 || /password|secret|credential|master.?key|token/iu.test(response.requestId)) malformedField('credential request');
      return response.requestId as OpaqueCredentialRequestId;
    },
    listConnections: async (): Promise<readonly RedactedConnectionProfile[]> => {
      const response = await invokeResponse(invoke, { method: 'connections/list' });
      if (!Array.isArray(response.profiles) || !response.profiles.every(isRedactedConnectionProfile)) malformedField('connection profiles');
      return response.profiles;
    },
    listCapabilities: async (): Promise<UiCapabilitySnapshot> => {
      const response = await invokeResponse(invoke, { method: 'capabilities/list' });
      if (!isUiCapabilitySnapshot(response.capabilities)) malformedField('capability snapshot');
      return response.capabilities;
    },
  });
}
