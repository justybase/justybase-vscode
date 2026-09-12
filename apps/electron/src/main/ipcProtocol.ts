import type {
  CapabilityDescriptor,
  OpaqueCredentialRequestId,
  RedactedConnectionProfile,
  UiConnectionProfileInput,
  UiAuthState,
  UiCapabilitySnapshot,
  UiPreloadResponse,
} from '@justybase/contracts';
import { isRedactedConnectionProfile, isUiAuthState, isUiCapabilitySnapshot, isUiConnectionProfileInput } from '@justybase/contracts';
import type { MainCredentialBroker } from './credentialBroker';

export const IPC_METHODS = [
  'auth/status',
  'credential/request',
  'connections/list',
  'connections/create',
  'connections/update',
  'connections/delete',
  'connections/test',
  'capabilities/list',
] as const;
export type IpcMethod = typeof IPC_METHODS[number];

export interface IpcMessage {
  readonly method: string;
  readonly payload?: unknown;
}

export interface IpcHandlers {
  readonly authStatus: () => Promise<UiAuthState> | UiAuthState;
  readonly credentialBroker: MainCredentialBroker;
  readonly listConnections: () => Promise<readonly RedactedConnectionProfile[]> | readonly RedactedConnectionProfile[];
  readonly createConnection: (input: UiConnectionProfileInput, requestId?: OpaqueCredentialRequestId) => Promise<RedactedConnectionProfile>;
  readonly updateConnection: (id: string, input: UiConnectionProfileInput, requestId?: OpaqueCredentialRequestId) => Promise<RedactedConnectionProfile>;
  readonly deleteConnection: (id: string) => Promise<void>;
  readonly testConnection: (id: string) => Promise<void>;
  readonly testConnectionProfile: (input: UiConnectionProfileInput, requestId?: OpaqueCredentialRequestId) => Promise<void>;
  readonly listCapabilities: () => Promise<UiCapabilitySnapshot> | UiCapabilitySnapshot;
}

interface ProfilePayload {
  readonly profile: UiConnectionProfileInput;
  readonly requestId?: OpaqueCredentialRequestId;
}

interface UpdateProfilePayload extends ProfilePayload {
  readonly id: string;
}

function isOpaqueRequestId(value: unknown): value is OpaqueCredentialRequestId {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/password|passphrase|secret|credential|master.?key|token|api.?key/iu.test(value);
}

function parseProfilePayload(value: unknown): ProfilePayload | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isUiConnectionProfileInput(candidate.profile)) return undefined;
  if (candidate.requestId !== undefined && !isOpaqueRequestId(candidate.requestId)) return undefined;
  return {
    profile: candidate.profile,
    ...(candidate.requestId === undefined ? {} : { requestId: candidate.requestId }),
  };
}

function parseUpdateProfilePayload(value: unknown): UpdateProfilePayload | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 256) return undefined;
  const profile = parseProfilePayload(value);
  return profile ? { ...profile, id: candidate.id } : undefined;
}

function parseIdPayload(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined;
}

function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => /password|passphrase|secret|credential|master.?key|token|api.?key/iu.test(key) || hasSecretKey(nested));
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
        return typeof requestId === 'string' && requestId.length > 0 && !/password|passphrase|secret|credential|master.?key|token|api.?key/iu.test(requestId)
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
      case 'connections/create': {
        const payload = parseProfilePayload(candidate.payload);
        if (!payload) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'A safe connection profile is required.' };
        const profile = await handlers.createConnection(payload.profile, payload.requestId);
        return isRedactedConnectionProfile(profile)
          ? { ok: true, profile }
          : { ok: false, code: 'INVALID_IPC_RESPONSE', message: 'Main returned an invalid connection profile.' };
      }
      case 'connections/update': {
        const payload = parseUpdateProfilePayload(candidate.payload);
        if (!payload) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'A connection ID and safe profile are required.' };
        const profile = await handlers.updateConnection(payload.id, payload.profile, payload.requestId);
        return isRedactedConnectionProfile(profile)
          ? { ok: true, profile }
          : { ok: false, code: 'INVALID_IPC_RESPONSE', message: 'Main returned an invalid connection profile.' };
      }
      case 'connections/delete': {
        const id = parseIdPayload(candidate.payload);
        if (!id) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'A connection ID is required.' };
        await handlers.deleteConnection(id);
        return { ok: true, operation: 'deleted' };
      }
      case 'connections/test': {
        const profile = parseProfilePayload(candidate.payload);
        if (profile) {
          await handlers.testConnectionProfile(profile.profile, profile.requestId);
          return { ok: true, operation: 'tested' };
        }
        const id = parseIdPayload(candidate.payload);
        if (!id) return { ok: false, code: 'INVALID_IPC_PAYLOAD', message: 'A connection ID or safe profile is required.' };
        await handlers.testConnection(id);
        return { ok: true, operation: 'tested' };
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
    return { ok: false, code: 'IPC_OPERATION_FAILED', message: /password|passphrase|secret|credential|master.?key|token|api.?key/iu.test(message) ? 'Electron operation failed.' : message || 'Electron operation failed.' };
  }
}

export function capabilitySnapshot(descriptors: readonly CapabilityDescriptor[]): UiCapabilitySnapshot {
  return { descriptors: descriptors.map(descriptor => ({ ...descriptor })) };
}
