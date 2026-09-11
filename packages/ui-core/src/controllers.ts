import type { DocumentPort, ExecutionPort, ExecutionHandle, ExecutionInput } from './ports';
import type { UiDocumentState, UiState } from './types';
import type { UiStore } from './store';

export interface WorkspaceController {
  open(uri?: string): Promise<UiDocumentState>;
  close(documentId: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createWorkspaceController(store: UiStore, documents: DocumentPort): WorkspaceController {
  let disposed = false;
  return {
    async open(uri?: string): Promise<UiDocumentState> {
      if (disposed) throw new Error('Workspace controller is disposed.');
      const snapshot = await documents.open(uri);
      const document: UiDocumentState = { ...snapshot };
      store.dispatch({ type: 'workspace/open-document', document });
      return document;
    },
    async close(documentId: string): Promise<void> {
      if (disposed) return;
      await documents.close(documentId);
      store.dispatch({ type: 'workspace/close-document', documentId });
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await documents.dispose();
    },
  };
}

export interface ExecutionController {
  run(input: ExecutionInput): Promise<ExecutionHandle>;
  cancel(sourceId: string, executionId: string): Promise<void>;
  dispose(): Promise<void>;
}

let cancellationSequence = 0;
function nextCancellationRequestId(): string {
  cancellationSequence += 1;
  return `cancel-${cancellationSequence.toString(36)}`;
}

function resultIdForExecution(state: UiState, sourceId: string, executionId: string): string | undefined {
  return Object.values(state.results.byResultSetId).find(result => result.sourceId === sourceId && result.executionId === executionId)?.resultSetId;
}

/**
 * Bridges one execution port to the reducer. Cancellation only invokes the
 * port's cancel operation; it never starts the SQL again as a fallback.
 */
export function createExecutionController(store: UiStore, execution: ExecutionPort): ExecutionController {
  let disposed = false;

  async function run(input: ExecutionInput): Promise<ExecutionHandle> {
    if (disposed) throw new Error('Execution controller is disposed.');
    const handle = await execution.start(input);
    store.dispatch({
      type: 'execution/start',
      sourceId: handle.sourceId,
      executionId: handle.executionId,
      resultSetId: handle.resultSetId,
    });
    void consumeEvents(handle);
    return handle;
  }

  async function consumeEvents(handle: ExecutionHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        if (disposed) return;
        store.dispatch({ type: 'execution/event', event });
      }
    } catch (error: unknown) {
      if (disposed) return;
      const resultSetId = resultIdForExecution(store.getState(), handle.sourceId, handle.executionId);
      if (!resultSetId) return;
      const lastSequence = store.getState().results.byResultSetId[`${handle.sourceId}\u0000${resultSetId}`]?.lastSequence ?? 0;
      store.dispatch({
        type: 'execution/event',
        event: {
          type: 'error',
          sourceId: handle.sourceId,
          executionId: handle.executionId,
          resultSetId,
          sequence: lastSequence + 1,
          message: error instanceof Error ? error.message : 'Execution stream failed.',
        },
      });
    }
  }

  return {
    run,
    async cancel(sourceId: string, executionId: string): Promise<void> {
      if (disposed) return;
      const resultSetId = resultIdForExecution(store.getState(), sourceId, executionId);
      if (!resultSetId) return;
      const requestId = nextCancellationRequestId();
      store.dispatch({ type: 'execution/cancel-requested', sourceId, executionId, requestId });
      try {
        const result = await execution.cancel(sourceId, executionId);
        if (result.status === 'acknowledged') {
          store.dispatch({ type: 'execution/cancel-acknowledged', sourceId, executionId, requestId });
        } else {
          store.dispatch({ type: 'execution/cancel-failed', sourceId, executionId, requestId, message: result.message ?? 'Cancellation failed.' });
        }
      } catch (error: unknown) {
        store.dispatch({ type: 'execution/cancel-failed', sourceId, executionId, requestId, message: error instanceof Error ? error.message : 'Cancellation failed.' });
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await execution.dispose();
    },
  };
}
