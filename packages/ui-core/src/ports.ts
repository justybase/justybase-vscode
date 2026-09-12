import type {
  CapabilityDescriptor,
  OpaqueCredentialRequestId,
  PersistenceEnvelope,
  RedactedConnectionProfile,
  UiAuthState,
  UiIdentity,
} from '@justybase/contracts';
import type { UiResultEvent, UiResultSurfaceState } from './types';

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type Unsubscribe = () => void;

/** Minimal cancellation shape shared by browser, host, and Electron adapters. */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface StoragePort extends Disposable {
  read<T>(key: string, identity: UiIdentity): Promise<PersistenceEnvelope<T> | undefined>;
  write<T>(key: string, envelope: PersistenceEnvelope<T>): Promise<void>;
  remove(key: string, identity: UiIdentity): Promise<void>;
}

export interface AuthPort extends Disposable {
  getState(signal?: CancellationSignal): Promise<UiAuthState>;
  requestCredential(purpose: 'login' | 'connection', signal?: CancellationSignal): Promise<OpaqueCredentialRequestId>;
  authenticate(username: string, credentialRequestId: OpaqueCredentialRequestId, signal?: CancellationSignal): Promise<UiAuthState>;
  logout(signal?: CancellationSignal): Promise<void>;
}

export interface ConnectionPort extends Disposable {
  list(signal?: CancellationSignal): Promise<readonly RedactedConnectionProfile[]>;
  select(connectionId: string | undefined, signal?: CancellationSignal): Promise<void>;
  connect(connectionId: string, credentialRequestId?: OpaqueCredentialRequestId, signal?: CancellationSignal): Promise<void>;
  disconnect(connectionId: string, signal?: CancellationSignal): Promise<void>;
}

export interface ClipboardPort extends Disposable {
  writeText(text: string, signal?: CancellationSignal): Promise<void>;
}

export interface DialogPort extends Disposable {
  alert(message: string, signal?: CancellationSignal): Promise<void>;
  confirm(message: string, signal?: CancellationSignal): Promise<boolean>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): Promise<void>;
}

export interface DocumentSnapshot {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly uri?: string;
  readonly content: string;
  readonly dirty: boolean;
}

export interface DocumentPort extends Disposable {
  open(uri?: string, signal?: CancellationSignal): Promise<DocumentSnapshot>;
  save(document: DocumentSnapshot, signal?: CancellationSignal): Promise<void>;
  close(documentId: string, signal?: CancellationSignal): Promise<void>;
}

export interface CommandPort extends Disposable {
  execute<T = unknown>(command: string, args?: readonly unknown[], signal?: CancellationSignal): Promise<T>;
}

export interface NavigationPort extends Disposable {
  reveal(uri: string, line?: number, column?: number, signal?: CancellationSignal): Promise<void>;
  openRoute(route: string, signal?: CancellationSignal): Promise<void>;
}

export interface CapabilityPort extends Disposable {
  list(): readonly CapabilityDescriptor[];
  get(key: string): CapabilityDescriptor | undefined;
  require(key: string): CapabilityDescriptor;
}

export interface EditorDiagnostic {
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly start: number;
  readonly end: number;
}

export interface EditorPort extends Disposable {
  setValue(sourceId: string, value: string): Promise<void>;
  requestCompletion(sourceId: string, offset: number, signal?: CancellationSignal): Promise<readonly unknown[]>;
  requestDiagnostics(sourceId: string, signal?: CancellationSignal): Promise<readonly EditorDiagnostic[]>;
  format(sourceId: string, signal?: CancellationSignal): Promise<string>;
}

export interface ExecutionInput {
  readonly sourceId: string;
  readonly sql: string;
  readonly connectionId: string;
  readonly mode: 'single' | 'script' | 'explain';
  /** Optional cursor location used by dialect adapters to select a statement. */
  readonly cursorOffset?: number;
  /** Short-lived confirmation fields for guarded write execution. */
  readonly writeConfirmed?: boolean;
  readonly writePreviewToken?: string;
}

export interface ExecutionHandle {
  readonly sourceId: string;
  readonly executionId: string;
  readonly resultSetId: string;
  readonly events: AsyncIterable<UiResultEvent>;
}

export interface CancellationResult {
  readonly requestId: string;
  readonly status: 'acknowledged' | 'failed';
  readonly message?: string;
}

export interface ExecutionPort extends Disposable {
  start(input: ExecutionInput, signal?: CancellationSignal): Promise<ExecutionHandle>;
  cancel(sourceId: string, executionId: string, signal?: CancellationSignal): Promise<CancellationResult>;
}

export interface ResultPageRequest {
  readonly sourceId: string;
  readonly executionId: string;
  readonly resultSetId: string;
  readonly offset: number;
  readonly limit: number;
  readonly globalFilter?: string;
  readonly columnFilters?: Readonly<Record<string, string>>;
  readonly sorting?: UiResultSurfaceState['view']['sorting'];
}

export interface ResultPage {
  readonly sourceId: string;
  readonly executionId: string;
  readonly resultSetId: string;
  readonly offset: number;
  readonly rows: readonly unknown[][];
  readonly totalRowCount: number;
}

export interface ResultPort extends Disposable {
  getPage(request: ResultPageRequest, signal?: CancellationSignal): Promise<ResultPage>;
  hydrate(identity: Pick<UiResultSurfaceState, 'sourceId' | 'executionId' | 'resultSetId'>, signal?: CancellationSignal): Promise<UiResultSurfaceState>;
  subscribe(listener: (event: UiResultEvent) => void): Unsubscribe;
  copyRow(identity: Pick<UiResultSurfaceState, 'sourceId' | 'executionId' | 'resultSetId'>, rowIndex: number, format: 'text' | 'json' | 'markdown', signal?: CancellationSignal): Promise<string>;
  export(identity: Pick<UiResultSurfaceState, 'sourceId' | 'executionId' | 'resultSetId'>, format: 'csv' | 'xlsx' | 'parquet', signal?: CancellationSignal): Promise<void>;
  guardedEdit(identity: Pick<UiResultSurfaceState, 'sourceId' | 'executionId' | 'resultSetId'>, rowIndex: number, values: readonly unknown[], signal?: CancellationSignal): Promise<void>;
}

export interface MetadataNode {
  readonly id: string;
  readonly parentId?: string;
  readonly kind: 'connection' | 'database' | 'schema' | 'group' | 'object' | 'column';
  readonly label: string;
  readonly description?: string;
  readonly viewSql?: string;
  readonly database?: string;
  readonly schema?: string;
  readonly objectName?: string;
  readonly objectType?: string;
  readonly columnType?: string;
  readonly hasChildren: boolean;
}

export interface MetadataPort extends Disposable {
  listChildren(parentId: string | undefined, signal?: CancellationSignal): Promise<readonly MetadataNode[]>;
  refresh(connectionId: string, signal?: CancellationSignal): Promise<void>;
  search(connectionId: string, term: string, signal?: CancellationSignal): Promise<readonly MetadataNode[]>;
}

export interface HistoryEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly executionId: string;
  readonly connectionId: string;
  readonly sqlFingerprint: string;
  readonly status: 'complete' | 'error' | 'cancelled';
  readonly createdAt: number;
}

export interface HistoryPort extends Disposable {
  list(signal?: CancellationSignal): Promise<readonly HistoryEntry[]>;
  open(entryId: string, signal?: CancellationSignal): Promise<HistoryEntry | undefined>;
  remove(entryId: string, signal?: CancellationSignal): Promise<void>;
  clear(signal?: CancellationSignal): Promise<void>;
}

export interface DesignerDraft {
  readonly targetId: string;
  readonly revision: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DesignerPort extends Disposable {
  load(targetId: string, signal?: CancellationSignal): Promise<DesignerDraft>;
  preview(draft: DesignerDraft, signal?: CancellationSignal): Promise<{ readonly sqlFingerprint: string; readonly statements: readonly string[] }>;
  apply(draft: DesignerDraft, previewFingerprint: string, signal?: CancellationSignal): Promise<void>;
}
