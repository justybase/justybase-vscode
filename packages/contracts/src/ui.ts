import type { DatabaseKind } from './database';

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

/**
 * Connection fields that may cross the Electron renderer boundary. The
 * password is deliberately absent; the main process resolves it from an
 * opaque broker request immediately before calling the authenticated API.
 */
export interface UiConnectionProfileInput {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly dbType: DatabaseKind;
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
  | { readonly ok: true; readonly operation: 'deleted' | 'tested' | 'window-opened' }
  | { readonly ok: true; readonly capabilities: UiCapabilitySnapshot }
  | { readonly ok: true; readonly file: ElectronSqlFile | null }
  | { readonly ok: true; readonly saved: ElectronSqlSaveResult | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface UiRendererBootstrap {
  readonly contractVersion: typeof UI_CONTRACT_VERSION;
  readonly productId: string;
  readonly sessionId: string;
  readonly capabilities: UiCapabilitySnapshot;
}

/** Soft warning threshold for SQL files opened in the Electron shell (warning, not an error). */
export const SOFT_SQL_FILE_WARN_BYTES = 2 * 1024 * 1024;
/** Hard safety cap for SQL file IPC payloads; aligns with the query file import limit. */
export const HARD_SQL_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const SQL_FILE_EXTENSION = 'sql';
export const MAX_SQL_FILE_PATH_LENGTH = 4096;

/** SQL file payload crossing the Electron main/renderer boundary. `null` means the native dialog was cancelled. */
export interface ElectronSqlFile {
  readonly filePath: string;
  readonly fileName: string;
  readonly content: string;
  readonly sizeBytes: number;
  /** True when the file exceeds the soft warning threshold but is still below the hard cap. */
  readonly oversize: boolean;
}

export interface ElectronSqlSaveResult {
  readonly filePath: string;
  readonly fileName: string;
  readonly sizeBytes: number;
}

/** Allowlisted preload surface exposed to a renderer; methods never carry raw credentials. */
export interface ElectronRendererApi {
  readonly getAuthState: () => Promise<UiAuthState>;
  readonly requestCredential: (purpose: 'login' | 'connection') => Promise<OpaqueCredentialRequestId>;
  readonly listConnections: () => Promise<readonly RedactedConnectionProfile[]>;
  readonly createConnection: (input: UiConnectionProfileInput, requestId?: OpaqueCredentialRequestId) => Promise<RedactedConnectionProfile>;
  readonly updateConnection: (id: string, input: UiConnectionProfileInput, requestId?: OpaqueCredentialRequestId) => Promise<RedactedConnectionProfile>;
  readonly deleteConnection: (id: string) => Promise<void>;
  readonly testConnection: (id: string) => Promise<void>;
  readonly testConnectionProfile: (input: UiConnectionProfileInput, requestId?: OpaqueCredentialRequestId) => Promise<void>;
  readonly listCapabilities: () => Promise<UiCapabilitySnapshot>;
  readonly openSqlFile: () => Promise<ElectronSqlFile | null>;
  readonly saveSqlFile: (filePath: string, content: string) => Promise<ElectronSqlSaveResult>;
  readonly saveSqlFileAs: (suggestedName: string | undefined, content: string) => Promise<ElectronSqlSaveResult | null>;
  /**
   * Opens an explicit absolute path supplied by the OS (file association,
   * protocol link, second instance). Main applies the same .sql/size/grant
   * guardrails as the dialog flow; the renderer must never send user-typed paths.
   */
  readonly openSqlFilePath: (filePath: string) => Promise<ElectronSqlFile>;
  /** Opens an additional product window owned by the same authenticated session. */
  readonly requestNewWindow: () => Promise<void>;
}

/**
 * Actions the main process may push to a renderer (application menu,
 * protocol links, OS file opens). The renderer validates every action before
 * dispatching it to its local document handlers.
 */
export const ELECTRON_MENU_ACTIONS = [
  'new-window',
  'open-file',
  'save-file',
  'save-file-as',
  'open-file-path',
] as const;
export type ElectronMenuAction = typeof ELECTRON_MENU_ACTIONS[number];

export interface ElectronMenuMessage {
  readonly action: ElectronMenuAction;
  /** Absolute .sql path; only present for `open-file-path`. */
  readonly filePath?: string;
}

/** Guard for main-to-renderer menu messages accepted by the preload bridge. */
export function isElectronMenuMessage(value: unknown): value is ElectronMenuMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.action !== 'string' || !(ELECTRON_MENU_ACTIONS as readonly string[]).includes(candidate.action)) return false;
  if (candidate.action === 'open-file-path') {
    if (!isSqlFilePathShape(candidate.filePath)) return false;
  } else if (candidate.filePath !== undefined) {
    return false;
  }
  return !hasSecretKey(candidate);
}

function nonEmptyString(value: unknown, maxLength = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

/** Runtime guard for the safe profile shape accepted by Electron IPC. */
export function isUiConnectionProfileInput(value: unknown): value is UiConnectionProfileInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return nonEmptyString(candidate.name, 200)
    && typeof candidate.host === 'string' && candidate.host.length <= 512
    && Number.isInteger(candidate.port) && (candidate.port as number) >= 0 && (candidate.port as number) <= 65535
    && nonEmptyString(candidate.database, 2048)
    && typeof candidate.user === 'string' && candidate.user.length <= 512
    && nonEmptyString(candidate.dbType, 64)
    && typeof candidate.readOnly === 'boolean'
    && !hasSecretKey(candidate);
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

function isSqlFilePathShape(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_SQL_FILE_PATH_LENGTH) return false;
  if (value.includes('\0')) return false;
  return value.toLowerCase().endsWith(`.${SQL_FILE_EXTENSION}`);
}

/** Shape guard for renderer-supplied SQL file paths; absoluteness is enforced by the main-process IPC boundary. */
export function isElectronSqlFilePath(value: unknown): value is string {
  return isSqlFilePathShape(value);
}

function isSqlFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= HARD_SQL_FILE_MAX_BYTES;
}

/** Guard for the SQL file payload returned through the preload bridge. */
export function isElectronSqlFile(value: unknown): value is ElectronSqlFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isSqlFilePathShape(candidate.filePath)
    && typeof candidate.fileName === 'string'
    && candidate.fileName.length > 0
    && candidate.fileName.length <= 512
    && typeof candidate.content === 'string'
    && candidate.content.length <= HARD_SQL_FILE_MAX_BYTES
    && isSqlFileSize(candidate.sizeBytes)
    && typeof candidate.oversize === 'boolean'
    && !hasSecretKey(candidate);
}

/** Guard for the SQL save result returned through the preload bridge. */
export function isElectronSqlSaveResult(value: unknown): value is ElectronSqlSaveResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isSqlFilePathShape(candidate.filePath)
    && typeof candidate.fileName === 'string'
    && candidate.fileName.length > 0
    && candidate.fileName.length <= 512
    && isSqlFileSize(candidate.sizeBytes)
    && !hasSecretKey(candidate);
}
