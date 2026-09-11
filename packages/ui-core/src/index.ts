export type {
  CapabilityPort,
  CancellationSignal,
  CancellationResult,
  ClipboardPort,
  CommandPort,
  DesignerDraft,
  DesignerPort,
  DialogPort,
  Disposable,
  DocumentPort,
  DocumentSnapshot,
  EditorDiagnostic,
  EditorPort,
  ExecutionHandle,
  ExecutionInput,
  ExecutionPort,
  HistoryEntry,
  HistoryPort,
  MetadataNode,
  MetadataPort,
  NavigationPort,
  ResultPage,
  ResultPageRequest,
  ResultPort,
  StoragePort,
  Unsubscribe,
} from './ports';
export {
  CapabilityRegistry,
  CapabilityUnavailableError,
} from './capabilities';
export {
  createDisposalCoordinator,
  disposeOnInitializationFailure,
} from './lifecycle';
export type { Cleanup, DisposalCoordinator } from './lifecycle';
export {
  createPersistenceEnvelope,
  decodePersistenceEnvelope,
  decodeWithLegacyFallback,
  encodePersistenceEnvelope,
  identitiesMatch,
  PersistenceCodec,
  PersistenceDecodeError,
} from './persistence';
export type { JsonPrimitive, JsonValue, LegacyPersistenceRead, PersistenceCodecOptions } from './persistence';
export { createUiStore } from './store';
export type { UiStore } from './store';
export { createExecutionController, createWorkspaceController } from './controllers';
export type { ExecutionController, WorkspaceController } from './controllers';
export { resolveUiMode } from './mode';
export { createInitialUiState, emptyResultView, reduceUiState, resultKey } from './reducer';
export type { InitialUiStateOptions } from './reducer';
export type {
  UiAction,
  UiCancellationStatus,
  UiConnectionState,
  UiDesignerState,
  UiDocumentState,
  UiHistoryState,
  UiMetadataState,
  UiResultEvent,
  UiResultEventBase,
  UiResultStatus,
  UiResultSurfaceState,
  UiResultViewState,
  UiResultsState,
  UiShellState,
  UiState,
  UiSurface,
  UiWorkspaceState,
} from './types';
