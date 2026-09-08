/**
 * Pure result-panel state model.
 *
 * `reduceResultPanelState` is a `state + event -> state` engine with no DOM,
 * transport, disk, or product dependencies. It freezes the transition rules
 * that the desktop `ResultStateManager` contract exercises (identity and pin
 * preservation across source switches and re-execution, index shifting on
 * close, streaming cancellation with late-chunk ignoring, and source removal
 * with survivor selection) so the host/webview adapters can migrate onto it
 * later. Presentation state (scroll, filters, selection) is out of scope.
 *
 * Conventions:
 * - `activeResultSetIndex` is the "next result set" counter, not a tab
 *   index. New results land at that index and the counter advances; closing
 *   a result shifts the counter and every pin above the closed index down.
 * - The first result set of an execution is the Log entry; its index is 0.
 * - `resultSetId` is preserved across switches/re-execution for surviving
 *   pinned results; pins are keyed by source + index and shift with closes.
 * - Streaming chunks are accepted only while the source is executing; after
 *   cancellation the source stops executing and late chunks are ignored.
 */

import {
  createResultSetId,
  ensureResultSetId,
  type ResultSetId,
} from './identity';

/** Column shape preserved from the desktop append message. */
export interface ResultColumn {
  name: string;
  type?: string;
  scale?: number;
}

/** One result set held by the pure model (data kept minimal; storage is out of scope). */
export interface ResultSetState {
  readonly resultSetId: ResultSetId;
  readonly isLog: boolean;
  readonly columns: ResultColumn[];
  data: unknown[][];
  totalRowCount: number;
  isCancelled?: boolean;
}

/** A pinned result: source + index identity; shifts with closes. */
export interface PinnedResultState {
  readonly sourceId: string;
  resultSetIndex: number;
  readonly timestamp: number;
  readonly label: string;
}

export interface SourceState {
  readonly sourceId: string;
  resultSets: ResultSetState[];
  /** Next result-set index; see module conventions. */
  activeResultSetIndex: number;
  isExecuting: boolean;
  /** Monotonic execution counter; together with sourceId it forms the execution identity. */
  executionEpoch: number;
}

export interface ResultPanelState {
  readonly sources: Map<string, SourceState>;
  activeSourceId?: string;
  pinnedResults: PinnedResultState[];
}

export interface StreamingChunk {
  readonly columns: ResultColumn[];
  readonly rows: unknown[][];
  readonly isFirstChunk: boolean;
  readonly isLastChunk: boolean;
  readonly totalRowsSoFar: number;
  readonly limitReached: boolean;
}

export interface AppendRowsProps {
  readonly command: 'appendRows';
  readonly resultSetIndex: number;
  readonly rows: unknown[][];
  readonly totalRows: number;
  readonly isLastChunk: boolean;
  readonly limitReached: boolean;
  readonly isFirstChunk?: boolean;
  readonly columns?: ResultColumn[];
  readonly resultSetId?: ResultSetId;
}

export type AppendStreamingOutcome =
  | { readonly type: 'incremental'; readonly props: AppendRowsProps }
  | { readonly type: 'ignore' };

export type ResultPanelEvent =
  | { readonly type: 'start-execution'; readonly sourceId: string }
  | { readonly type: 'update-results'; readonly sourceId: string; readonly resultSets: Array<Omit<ResultSetState, 'isLog'>> }
  | { readonly type: 'append-streaming-chunk'; readonly sourceId: string; readonly chunk: StreamingChunk; readonly sql?: string }
  | { readonly type: 'cancel-execution'; readonly sourceId: string; readonly resultSetIndices: readonly number[] }
  | { readonly type: 'close-result'; readonly sourceId: string; readonly resultSetIndex: number }
  | { readonly type: 'close-source'; readonly sourceId: string }
  | { readonly type: 'set-active-source'; readonly sourceId: string }
  | { readonly type: 'set-active-result-set-index'; readonly sourceId: string; readonly resultSetIndex: number }
  | { readonly type: 'toggle-result-pin'; readonly sourceId: string; readonly resultSetIndex: number; readonly label?: string };

export function createEmptyResultPanelState(): ResultPanelState {
  return { sources: new Map(), pinnedResults: [] };
}

function logResultSet(): ResultSetState {
  return {
    resultSetId: createResultSetId(),
    isLog: true,
    columns: [],
    data: [],
    totalRowCount: 0,
  };
}

function cloneSource(source: SourceState): SourceState {
  return {
    ...source,
    resultSets: source.resultSets.slice(),
  };
}

function cloneState(state: ResultPanelState): ResultPanelState {
  return {
    sources: new Map(state.sources),
    activeSourceId: state.activeSourceId,
    pinnedResults: state.pinnedResults.slice(),
  };
}

function findPin(state: ResultPanelState, sourceId: string, resultSetIndex: number): PinnedResultState | undefined {
  return state.pinnedResults.find(pin => pin.sourceId === sourceId && pin.resultSetIndex === resultSetIndex);
}

/** Classifies a streaming chunk against the previous state without mutating it. */
export function classifyStreamingChunk(state: ResultPanelState, sourceId: string): AppendStreamingOutcome['type'] {
  const source = state.sources.get(sourceId);
  if (!source || !source.isExecuting) return 'ignore';
  return 'incremental';
}

/** Public read helpers (selector-style access for adapters). */
export function getResultSets(state: ResultPanelState, sourceId: string): ResultSetState[] {
  return state.sources.get(sourceId)?.resultSets ?? [];
}

export function getActiveResultSetIndex(state: ResultPanelState, sourceId: string): number {
  return state.sources.get(sourceId)?.activeResultSetIndex ?? 0;
}

/**
 * Applies one event to the result-panel state. Pure: never mutates the input;
 * returns a new state (sharing unchanged leaf structures).
 */
export function reduceResultPanelState(state: ResultPanelState, event: ResultPanelEvent): ResultPanelState {
  switch (event.type) {
    case 'start-execution': {
      const next = cloneState(state);
      next.activeSourceId = event.sourceId;
      const existing = next.sources.get(event.sourceId);
      if (existing) {
        const source = cloneSource(existing);
        source.resultSets = [logResultSet()];
        source.activeResultSetIndex = 1;
        source.isExecuting = true;
        source.executionEpoch += 1;
        next.sources.set(event.sourceId, source);
      } else {
        next.sources.set(event.sourceId, {
          sourceId: event.sourceId,
          resultSets: [logResultSet()],
          activeResultSetIndex: 1,
          isExecuting: true,
          executionEpoch: 1,
        });
      }
      return next;
    }

    case 'update-results': {
      const source = state.sources.get(event.sourceId);
      if (!source) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      const hasLog = updated.resultSets[0]?.isLog === true;
      const incoming = event.resultSets.map(resultSet => ensureResultSetId({ ...resultSet, isLog: false }));
      updated.resultSets = hasLog
        ? [updated.resultSets[0], ...incoming]
        : incoming;
      updated.activeResultSetIndex = updated.resultSets.length;
      updated.isExecuting = false;
      // Automatic pin on the last delivered result, unless already pinned there.
      const lastIndex = updated.resultSets.length - 1;
      if (lastIndex >= 0 && !findPin(next, event.sourceId, lastIndex)) {
        next.pinnedResults.push({
          sourceId: event.sourceId,
          resultSetIndex: lastIndex,
          timestamp: Date.now(),
          label: `Result ${lastIndex}`,
        });
      }
      next.sources.set(event.sourceId, updated);
      return next;
    }

    case 'append-streaming-chunk': {
      const source = state.sources.get(event.sourceId);
      if (!source || !source.isExecuting) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      const { chunk } = event;
      let target = updated.resultSets[updated.activeResultSetIndex];
      if (!target || target.isLog) {
        target = {
          resultSetId: createResultSetId(),
          isLog: false,
          columns: chunk.columns,
          data: [],
          totalRowCount: 0,
        };
        updated.resultSets[updated.activeResultSetIndex] = target;
      }
      target.data = target.data.concat(chunk.rows);
      target.totalRowCount = chunk.totalRowsSoFar;
      updated.activeResultSetIndex += 1;
      next.sources.set(event.sourceId, updated);
      return next;
    }

    case 'cancel-execution': {
      const source = state.sources.get(event.sourceId);
      if (!source) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      for (const index of event.resultSetIndices) {
        const resultSet = updated.resultSets[index];
        if (resultSet && !resultSet.isLog) {
          updated.resultSets[index] = { ...resultSet, isCancelled: true };
        }
      }
      updated.isExecuting = false;
      next.sources.set(event.sourceId, updated);
      return next;
    }

    case 'close-result': {
      const source = state.sources.get(event.sourceId);
      if (!source || event.resultSetIndex < 0 || event.resultSetIndex >= source.resultSets.length) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      updated.resultSets.splice(event.resultSetIndex, 1);
      if (updated.activeResultSetIndex > event.resultSetIndex) {
        updated.activeResultSetIndex -= 1;
      }
      next.sources.set(event.sourceId, updated);
      const removedIndex = event.resultSetIndex;
      next.pinnedResults = next.pinnedResults
        .filter(pin => !(pin.sourceId === event.sourceId && pin.resultSetIndex === removedIndex))
        .map(pin => {
          if (pin.sourceId !== event.sourceId) return pin;
          return pin.resultSetIndex > removedIndex
            ? { ...pin, resultSetIndex: pin.resultSetIndex - 1 }
            : pin;
        });
      return next;
    }

    case 'close-source': {
      const next = cloneState(state);
      next.sources.delete(event.sourceId);
      next.pinnedResults = next.pinnedResults.filter(pin => pin.sourceId !== event.sourceId);
      if (next.activeSourceId === event.sourceId) {
        next.activeSourceId = next.sources.keys().next().value as string | undefined;
      }
      return next;
    }

    case 'set-active-source': {
      if (!state.sources.has(event.sourceId)) return state;
      const next = cloneState(state);
      next.activeSourceId = event.sourceId;
      return next;
    }

    case 'set-active-result-set-index': {
      const source = state.sources.get(event.sourceId);
      if (!source) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      updated.activeResultSetIndex = event.resultSetIndex;
      next.sources.set(event.sourceId, updated);
      return next;
    }

    case 'toggle-result-pin': {
      const source = state.sources.get(event.sourceId);
      if (!source || event.resultSetIndex < 0) return state;
      const next = cloneState(state);
      const existing = findPin(next, event.sourceId, event.resultSetIndex);
      if (existing) {
        next.pinnedResults = next.pinnedResults.filter(pin => pin !== existing);
      } else {
        next.pinnedResults.push({
          sourceId: event.sourceId,
          resultSetIndex: event.resultSetIndex,
          timestamp: Date.now(),
          label: event.label ?? `Result ${event.resultSetIndex}`,
        });
      }
      return next;
    }
  }
}