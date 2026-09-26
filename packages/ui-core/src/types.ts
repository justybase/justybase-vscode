import { UI_CONTRACT_VERSION } from '@justybase/contracts';
import type {
  CapabilityDescriptor,
  DatabaseErrorDetails,
  DatabaseKind,
  PersistenceScope,
  QueryColumnFilterOperator,
  RedactedConnectionProfile,
  UiAuthState,
  UiIdentity,
  UiMode,
  UiOperationStatus,
} from '@justybase/contracts';

export type UiSurface = 'workspace' | 'editor' | 'results' | 'schema' | 'history' | 'explain' | 'designer';

export interface UiDocumentState {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly uri?: string;
  readonly content: string;
  readonly dirty: boolean;
  readonly connectionId?: string;
  /** Database used for unqualified SQL authoring in this document. */
  readonly database?: string;
  /** Optional schema used for unqualified SQL authoring in this document. */
  readonly schema?: string;
  /** Authoring profile may be changed independently of the active runtime connection. */
  readonly databaseKind?: DatabaseKind;
}

export interface UiWorkspaceState {
  readonly documentOrder: readonly string[];
  readonly documents: Readonly<Record<string, UiDocumentState>>;
  readonly activeDocumentId?: string;
}

export interface UiShellState {
  readonly status: UiOperationStatus;
  readonly activeSurface: UiSurface;
  readonly sidebarOpen: boolean;
  readonly message?: string;
}

export interface UiConnectionState {
  readonly status: UiOperationStatus;
  readonly profiles: readonly RedactedConnectionProfile[];
  readonly selectedConnectionId?: string;
  readonly message?: string;
}

export type UiResultStatus = 'idle' | 'loading' | 'streaming' | 'complete' | 'empty' | 'error' | 'cancelled';
export type UiCancellationStatus = 'none' | 'requested' | 'acknowledged' | 'cancelled' | 'failed';

/** Execution modes exposed by the shared authoring surface. */
export type UiExecutionMode = 'single' | 'smart' | 'script' | 'explain';
/** Modes accepted by the server-backed execution port. Smart is an authoring
 * convenience and is resolved to a concrete mode before crossing the port. */
export type UiExecutionRequestMode = Exclude<UiExecutionMode, 'smart'>;
export type UiExecutionStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';
export type UiStatementExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled' | 'skipped';

/** State for one statement in a single or script execution. */
export interface UiStatementExecutionState {
  readonly statementIndex: number;
  readonly status: UiStatementExecutionStatus;
  readonly resultSetId?: string;
  readonly sql?: string;
  readonly message?: string;
  /** Backend diagnostics of a failed statement, when the producer supplied them. */
  readonly errorDetails?: DatabaseErrorDetails;
}

/**
 * Execution-level state is deliberately separate from result state. A script
 * can have several result sets, including a failed statement and skipped
 * statements, while each result surface keeps its own row/event lifecycle.
 */
export interface UiExecutionState {
  readonly sourceId: string;
  readonly executionId: string;
  readonly mode: UiExecutionMode;
  readonly statementCount: number;
  readonly completedStatements: number;
  readonly status: UiExecutionStatus;
  readonly message?: string;
  readonly statements: Readonly<Record<number, UiStatementExecutionState>>;
}

export interface UiExecutionsState {
  readonly activeExecutionId?: string;
  readonly byExecutionId: Readonly<Record<string, UiExecutionState>>;
}

/** Typed filter state shared by the grid renderer and query adapters. */
export interface UiResultColumnFilterDefinition {
  readonly operator: QueryColumnFilterOperator;
  readonly value: string;
  readonly values?: readonly unknown[];
}

export interface UiResultViewState {
  readonly globalFilter: string;
  readonly columnFilters: Readonly<Record<string, string>>;
  /** Optional typed definition for Excel-style operators and value lists. */
  readonly columnFilterDefinitions?: Readonly<Record<string, UiResultColumnFilterDefinition>>;
  readonly sorting: readonly { readonly column: string; readonly descending: boolean }[];
  readonly grouping: readonly string[];
  readonly aggregation?: string;
  readonly pivotColumn?: string;
  /** Optional grid presentation state shared by host shells. */
  readonly columnVisibility?: Readonly<Record<string, boolean>>;
  readonly columnOrder?: readonly string[];
  readonly pinnedColumns?: readonly string[];
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly anchorRow?: number;
  /** Row geometry used when scrollTop was persisted; absent means legacy geometry. */
  readonly scrollRowHeight?: number;
}

/** Renderer-safe metadata required for canonical result-cell formatting. */
export interface UiResultColumn {
  readonly name: string;
  readonly type?: string;
  readonly scale?: number;
  readonly inferredNumericKind?: 'integer' | 'decimal';
  readonly inferredDateInteger?: boolean;
}

/**
 * A renderer-safe result projection. Rows remain in the adapter's paging or
 * spool store; this state carries only identity, counts, status and view
 * choices needed to ask the adapter for the visible page.
 */
export interface UiResultSurfaceState {
  readonly sourceId: string;
  readonly executionId: string;
  readonly resultSetId: string;
  readonly storageId?: string;
  readonly statementIndex: number;
  readonly status: UiResultStatus;
  readonly columns: readonly UiResultColumn[];
  readonly totalRowCount: number;
  readonly loadedRowCount: number;
  readonly message?: string;
  /** Backend diagnostics (SQLSTATE, severity, detail, hint) for an error result. */
  readonly errorDetails?: DatabaseErrorDetails;
  /** True when the server stopped at its row limit; the spool holds a prefix. */
  readonly limitReached?: boolean;
  readonly lastSequence: number;
  readonly cancellation: UiCancellationStatus;
  readonly cancelRequestId?: string;
  readonly batchStatus?: UiExecutionStatus;
  readonly batchMessage?: string;
  readonly view: UiResultViewState;
}

export interface UiResultsState {
  readonly activeSourceId?: string;
  readonly activeResultSetId?: string;
  readonly byResultSetId: Readonly<Record<string, UiResultSurfaceState>>;
}

export interface UiMetadataState {
  readonly status: UiOperationStatus;
  readonly selectedNodeId?: string;
  readonly expandedNodeIds: readonly string[];
  readonly message?: string;
}

export interface UiHistoryState {
  readonly status: UiOperationStatus;
  readonly entryIds: readonly string[];
  readonly selectedEntryId?: string;
  readonly message?: string;
}

export interface UiDesignerState {
  readonly status: UiOperationStatus;
  readonly targetId?: string;
  readonly dirty: boolean;
  readonly message?: string;
}

export interface UiState {
  readonly contractVersion: typeof UI_CONTRACT_VERSION;
  readonly mode: UiMode;
  readonly identity: UiIdentity;
  readonly auth: UiAuthState;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly shell: UiShellState;
  readonly workspace: UiWorkspaceState;
  readonly connections: UiConnectionState;
  readonly executions: UiExecutionsState;
  readonly results: UiResultsState;
  readonly metadata: UiMetadataState;
  readonly history: UiHistoryState;
  readonly designer: UiDesignerState;
  readonly persistenceScope: PersistenceScope;
}

export interface UiResultEventBase {
  readonly sourceId: string;
  readonly executionId: string;
  readonly resultSetId: string;
  readonly sequence: number;
  readonly statementIndex?: number;
}

export type UiResultEvent =
  | (UiResultEventBase & { readonly type: 'started'; readonly mode?: Exclude<UiExecutionMode, 'smart'>; readonly statementCount?: number })
  | (UiResultEventBase & { readonly type: 'statement-started'; readonly statementSql?: string })
  | (UiResultEventBase & { readonly type: 'columns'; readonly columns: readonly UiResultColumn[] })
  | (UiResultEventBase & { readonly type: 'session'; readonly storageId: string; readonly totalRowCount: number })
  | (UiResultEventBase & { readonly type: 'rows'; readonly rowCount: number; readonly totalRowCount: number })
  | (UiResultEventBase & { readonly type: 'progress'; readonly totalRowCount: number })
  | (UiResultEventBase & { readonly type: 'complete'; readonly totalRowCount: number; readonly message?: string; readonly limitReached?: boolean })
  | (UiResultEventBase & { readonly type: 'empty'; readonly message?: string })
  | (UiResultEventBase & { readonly type: 'error'; readonly message: string; readonly errorDetails?: DatabaseErrorDetails })
  | (UiResultEventBase & { readonly type: 'cancelled'; readonly totalRowCount: number; readonly message?: string });

export type UiAction =
  | { readonly type: 'mode/set'; readonly mode: UiMode }
  | { readonly type: 'auth/set'; readonly auth: UiAuthState }
  | { readonly type: 'capabilities/set'; readonly capabilities: readonly CapabilityDescriptor[] }
  | { readonly type: 'shell/status'; readonly status: UiOperationStatus; readonly message?: string }
  | { readonly type: 'shell/surface'; readonly surface: UiSurface }
  | { readonly type: 'shell/sidebar'; readonly open: boolean }
  | { readonly type: 'workspace/open-document'; readonly document: UiDocumentState }
  | { readonly type: 'workspace/update-document'; readonly documentId: string; readonly patch: Partial<UiDocumentState> }
  | { readonly type: 'workspace/close-document'; readonly documentId: string }
  | { readonly type: 'workspace/select-document'; readonly documentId: string }
  | { readonly type: 'connections/status'; readonly status: UiOperationStatus; readonly message?: string }
  | { readonly type: 'connections/set-profiles'; readonly profiles: readonly RedactedConnectionProfile[] }
  | { readonly type: 'connections/select'; readonly connectionId?: string }
  | { readonly type: 'execution/start'; readonly sourceId: string; readonly executionId: string; readonly resultSetId: string; readonly statementIndex?: number; readonly storageId?: string; readonly mode?: UiExecutionMode; readonly statementCount?: number; readonly statementSql?: string }
  | { readonly type: 'execution/event'; readonly event: UiResultEvent }
  | { readonly type: 'execution/statement-status'; readonly sourceId: string; readonly executionId: string; readonly statementIndex: number; readonly status: UiStatementExecutionStatus; readonly resultSetId?: string; readonly sql?: string; readonly message?: string }
  | { readonly type: 'execution/batch-complete'; readonly sourceId: string; readonly executionId: string; readonly status: Exclude<UiExecutionStatus, 'idle' | 'running'>; readonly statementCount?: number; readonly completedStatements: number; readonly message?: string }
  | { readonly type: 'execution/stream-failed'; readonly sourceId: string; readonly executionId: string; readonly resultSetId: string; readonly message: string; readonly errorDetails?: DatabaseErrorDetails }
  | {
    readonly type: 'results/hydrate';
    readonly sourceId: string;
    readonly executionId: string;
    readonly resultSetId: string;
    readonly loadedRowCount: number;
    readonly totalRowCount?: number;
    readonly columns?: readonly UiResultColumn[];
  }
  | { readonly type: 'execution/cancel-requested'; readonly sourceId: string; readonly executionId: string; readonly requestId: string }
  | { readonly type: 'execution/cancel-acknowledged'; readonly sourceId: string; readonly executionId: string; readonly requestId: string }
  | { readonly type: 'execution/cancel-failed'; readonly sourceId: string; readonly executionId: string; readonly requestId: string; readonly message: string }
  | { readonly type: 'results/select-source'; readonly sourceId?: string }
  | { readonly type: 'results/select'; readonly resultSetId: string; readonly sourceId?: string }
  | { readonly type: 'results/reconcile-source'; readonly sourceId: string; readonly resultSetIds: readonly string[] }
  | { readonly type: 'results/view'; readonly resultSetId: string; readonly sourceId?: string; readonly patch: Partial<UiResultViewState> }
  | { readonly type: 'metadata/status'; readonly status: UiOperationStatus; readonly message?: string }
  | { readonly type: 'metadata/select'; readonly nodeId?: string }
  | { readonly type: 'metadata/toggle-expanded'; readonly nodeId: string }
  | { readonly type: 'metadata/set-expanded'; readonly nodeIds: readonly string[] }
  | { readonly type: 'history/status'; readonly status: UiOperationStatus; readonly message?: string }
  | { readonly type: 'history/select'; readonly entryId?: string }
  | { readonly type: 'designer/status'; readonly status: UiOperationStatus; readonly message?: string }
  | { readonly type: 'designer/target'; readonly targetId?: string }
  | { readonly type: 'designer/dirty'; readonly dirty: boolean };
