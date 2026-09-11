import type {
  CapabilityDescriptor,
  RedactedConnectionProfile,
  UiAuthState,
  UiCapabilitySnapshot,
  UiPreloadResponse,
} from '@justybase/contracts';
import { isRedactedConnectionProfile, isUiAuthState, isUiCapabilitySnapshot } from '@justybase/contracts';
import type { MainCredentialBroker } from './credentialBroker';

export const IPC_METHODS = ['auth/status', 'credential/request', 'connections/list', 'capabilities/list'] as const;
export type IpcMethod = typeof IPC_METHODS[number];

export interface IpcMessage {
  readonly method: string;
  readonly payload?: unknown;
}

export interface IpcHandlers {
  readonly authStatus: () => Promise<UiAuthState> | UiAuthState;
  readonly credentialBroker: MainCredentialBroker;
  readonly listConnections: () => Promise<readonly RedactedConnectionProfile[]> | readonly RedactedConnectionProfile[];
  readonly listCapabilities: () => Promise<UiCapabilitySnapshot> | UiCapabilitySnapshot;
}

function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => /password|secret|credential|master.?key|token/iu.test(key) || hasSecretKey(nested));
}

function validMethod(value: string): value is IpcMethod {
  return (IPC_METHODS as readonly string[]).includes(value);
}

/** Validates malformed/unknown messages before a host handler is invoked. */
export async function dispatchIpcMessage(message: unknown, handlers: IpcHandlers): Promise<UiPreloadResponse> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return { ok: false, code: 'INVALID_IPC_MESSAGE', message: 'IPC message must be an object.' };
  const candidate = message as Partial<IpcMessage>;
  if (typeof candidate.method !== 'string' || !validMethod(candidate.method)) return { ok: false, code: 'UNKNOWN_IPC_METHOD', message: 'IPC method is not allowed.' };
  if (hasSecretKey(candidate)) return { ok: false, code: 'SECRET_IN_IPC', message: 'Credentials must be handled by the main-process broker.' };
  try {
    switch (candidate.method) {
      case 'auth/status':
        if (candidate.payload !== undefined) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'auth/status does not accept a payload.' };
        {
          const auth = await handlers.authStatus();
          return isUiAuthState(auth)
            ? { ok: true, auth }
            : { ok: false, code: 'INVALID_IPC_RESPONSE', message: 'Main returned an invalid auth state.' };
        }
      case 'credential/request': {
        if (typeof candidate.payload !== 'object' || candidate.payload === null || Array.isArray(candidate.payload)) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'Credential purpose is required.' };
        const purpose = (candidate.payload as { purpose?: unknown }).purpose;
        if (purpose !== 'login' && purpose !== 'connection') return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'Credential purpose is invalid.' };
        const requestId = await handlers.credentialBroker.request(purpose);
        return typeof requestId === 'string' && requestId.length > 0 && !/password|secret|credential|master.?key|token/iu.test(requestId)
          ? { ok: true, requestId }
          : { ok: false, code: 'INVALID_IPC_RESPONSE', message: 'Main returned an invalid credential request.' };
      }
      case 'connections/list': {
        if (candidate.payload !== undefined) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'connections/list does not accept a payload.' };
        const profiles = await handlers.listConnections();
        return Array.isArray(profiles) && profiles.every(isRedactedConnectionProfile)
          ? { ok: true, profiles }
          : { ok: false, code: 'INVALID_IPC_RESPONSE', message: 'Main returned an invalid connection profile.' };
      }
      case 'capabilities/list': {
        if (candidate.payload !== undefined) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'capabilities/list does not accept a payload.' };
        const capabilities = await handlers.listCapabilities();
        return isUiCapabilitySnapshot(capabilities)
          ? { ok: true, capabilities }
          : { ok: false, code: 'INVALID_IPC_RESPONSE', message: 'Main returned an invalid capability snapshot.' };
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    return { ok: false, code: 'IPC_OPERATION_FAILED', message: /password|secret|credential|master.?key|token/iu.test(message) ? 'Electron operation failed.' : message || 'Electron operation failed.' };
  }
}

export function capabilitySnapshot(descriptors: readonly CapabilityDescriptor[]): UiCapabilitySnapshot {
  return { descriptors: descriptors.map(descriptor => ({ ...descriptor })) };
}
