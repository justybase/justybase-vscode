/**
 * Additive contracts shared by the cross-product UI adapters.
 *
 * These values are deliberately serializable.  They describe identity and
 * capability state, but never contain database credentials, driver handles,
 * VS Code objects, DOM nodes, or complete result buffers.
 */

export const UI_CONTRACT_VERSION = 1 as const;

export type UiMode = 'legacy' | 'shared';

/** Identity axes must stay separate; a tab index is not an identity. */
export interface UiIdentity {
  readonly productId: string;
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly documentId?: string;
  readonly connectionId?: string;
  readonly sourceId?: string;
  readonly executionId?: string;
  readonly resultSetId?: string;
  readonly storageId?: string;
}

export type CapabilityStatus =
  | 'available'
  | 'unavailable'
  | 'requires-auth'
  | 'read-only'
  | 'unsupported'
  | 'degraded';

export interface CapabilityDescriptor {
  readonly key: string;
  readonly status: CapabilityStatus;
  readonly owner: string;
  readonly reason?: string;
  readonly documentation: string;
  readonly removalCondition: string;
}

export type PersistenceScope = 'user' | 'profile' | 'workspace' | 'global';

export interface PersistenceEnvelope<T> {
  readonly schemaVersion: number;
  readonly scope: PersistenceScope;
  readonly identity: UiIdentity;
  readonly payload: T;
}

/** An opaque handle allows a host to broker a secret without exposing it. */
export type OpaqueCredentialRequestId = string & { readonly __opaqueCredentialRequestId: unique symbol };

export interface UiAuthState {
  readonly status: 'authenticated' | 'unauthenticated' | 'requires-auth' | 'error';
  readonly userId?: string;
  readonly username?: string;
  readonly message?: string;
  readonly sessionId?: string;
}

/** Connection data safe to send to a renderer or persist in UI state. */
export interface RedactedConnectionProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly dbType: string;
  readonly readOnly: boolean;
}

export type UiOperationStatus = 'idle' | 'loading' | 'running' | 'streaming' | 'complete' | 'error' | 'cancelled';

export interface UiOperationState {
  readonly status: UiOperationStatus;
  readonly message?: string;
  readonly requestId?: string;
}

export interface UiCapabilitySnapshot {
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly updatedAt?: number;
}

const capabilityStatuses: readonly CapabilityStatus[] = ['available', 'unavailable', 'requires-auth', 'read-only', 'unsupported', 'degraded'];

const secretKeyPattern = /(?:password|passphrase|secret|credential|master.?key|access.?token|refresh.?token|api.?key|token)$/iu;

/**
 * Renderer-bound values may contain additive fields, so checking only the
 * fields known by the current contract is not sufficient. Walk every nested
 * object/array and reject secret-shaped keys before the value crosses IPC.
 */
function hasSecretKey(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => hasSecretKey(item, seen));
  return Object.entries(value).some(([key, nested]) => secretKeyPattern.test(key) || hasSecretKey(nested, seen));
}

export function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.key === 'string'
    && candidate.key.length > 0
    && typeof candidate.owner === 'string'
    && candidate.owner.length > 0
    && typeof candidate.documentation === 'string'
    && candidate.documentation.length > 0
    && typeof candidate.removalCondition === 'string'
    && candidate.removalCondition.length > 0
    && capabilityStatuses.includes(candidate.status as CapabilityStatus)
    && (candidate.reason === undefined || typeof candidate.reason === 'string')
    && !hasSecretKey(candidate);
}

export function isUiCapabilitySnapshot(value: unknown): value is UiCapabilitySnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.descriptors)
    && candidate.descriptors.every(isCapabilityDescriptor)
    && (candidate.updatedAt === undefined || (typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)))
    && !hasSecretKey(candidate);
}

export function isUiAuthState(value: unknown): value is UiAuthState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return ['authenticated', 'unauthenticated', 'requires-auth', 'error'].includes(String(candidate.status))
    && (candidate.userId === undefined || typeof candidate.userId === 'string')
    && (candidate.username === undefined || typeof candidate.username === 'string')
    && (candidate.message === undefined || typeof candidate.message === 'string')
    && (candidate.sessionId === undefined || typeof candidate.sessionId === 'string')
    && !hasSecretKey(candidate);
}

export interface UiPreloadAuthRequest {
  readonly type: 'auth/status';
}

export interface UiPreloadCredentialRequest {
  readonly type: 'credential/request';
  /** Optional correlation for callers that already have one; the broker owns the response ID. */
  readonly requestId?: OpaqueCredentialRequestId;
  readonly purpose: 'connection' | 'login';
}

export interface UiPreloadConnectionsRequest {
  readonly type: 'connections/list';
}

export interface UiPreloadCapabilitiesRequest {
  readonly type: 'capabilities/list';
}

export interface UiPreloadRequest {
  readonly request: UiPreloadAuthRequest | UiPreloadCredentialRequest | UiPreloadConnectionsRequest | UiPreloadCapabilitiesRequest;
}

export type UiPreloadResponse =
  | { readonly ok: true; readonly auth: UiAuthState }
  | { readonly ok: true; readonly requestId: OpaqueCredentialRequestId }
  | { readonly ok: true; readonly profile: RedactedConnectionProfile }
  | { readonly ok: true; readonly profiles: readonly RedactedConnectionProfile[] }
  | { readonly ok: true; readonly capabilities: UiCapabilitySnapshot }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface UiRendererBootstrap {
  readonly contractVersion: typeof UI_CONTRACT_VERSION;
  readonly productId: string;
  readonly sessionId: string;
  readonly capabilities: UiCapabilitySnapshot;
}

/** Allowlisted preload surface exposed to a renderer; methods never carry raw credentials. */
export interface ElectronRendererApi {
  readonly getAuthState: () => Promise<UiAuthState>;
  readonly requestCredential: (purpose: 'login' | 'connection') => Promise<OpaqueCredentialRequestId>;
  readonly listConnections: () => Promise<readonly RedactedConnectionProfile[]>;
  readonly listCapabilities: () => Promise<UiCapabilitySnapshot>;
}

/** Runtime guard used at IPC boundaries before a value enters the renderer. */
export function isRedactedConnectionProfile(value: unknown): value is RedactedConnectionProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.host === 'string'
    && typeof candidate.port === 'number'
    && Number.isInteger(candidate.port)
    && typeof candidate.database === 'string'
    && typeof candidate.user === 'string'
    && typeof candidate.dbType === 'string'
    && typeof candidate.readOnly === 'boolean'
    && !hasSecretKey(candidate);
}
