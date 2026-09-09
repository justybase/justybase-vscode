/**
 * Pure result-panel state model.
 *
 * The model owns structural state only. Hosts keep transport handles,
 * timers, logs, disk stores and other platform resources beside it. Every
 * transition is deterministic: IDs and timestamps are supplied by adapter
 * events rather than being minted inside the reducer.
 */

import type { ExecutionId, ResultSetId } from './identity';

/** Column shape shared by desktop and web result adapters. */
export interface ResultColumn {
  name: string;
  type?: string;
  scale?: number;
}

export type ResultSetStatus = 'streaming' | 'complete' | 'cancelled' | 'error' | 'empty';

/** Structural result state. Row buffers remain adapter-owned in production. */
export interface ResultSetState {
  resultSetId: ResultSetId;
  sourceId: string;
  executionId?: ExecutionId;
  statementIndex?: number;
  storageSessionId?: string;
  isLog: boolean;
  columns: ResultColumn[];
  data: unknown[][];
  totalRowCount: number;
  loadedRowCount: number;
  status: ResultSetStatus;
  limitReached: boolean;
  isCancelled?: boolean;
  lastChunkSequence?: number;
}

/** Input used when a completed result is delivered by an adapter. */
export type ResultSetInput = Omit<ResultSetState, 'isLog' | 'sourceId'> & {
  sourceId?: string;
  isLog?: false;
};

/** A pin is keyed by stable result identity; index is only a UI projection. */
export interface PinnedResultState {
  sourceId: string;
  resultSetId: ResultSetId;
  resultSetIndex: number;
  timestamp: number;
  label: string;
  automatic?: boolean;
}

export interface SourceState {
  sourceId: string;
  resultSets: ResultSetState[];
  /** Actual selected result index, never a "next result" counter. */
  activeResultSetIndex: number;
  activeResultSetId?: ResultSetId;
  isExecuting: boolean;
  executionId?: ExecutionId;
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
  readonly isCancelled?: boolean;
  readonly fromRow?: number;
  readonly chunkSequence?: number;
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

type ResultPinMetadata = {
  readonly timestamp: number;
  readonly label?: string;
};

export type ResultPanelEvent =
  | {
      readonly type: 'start-execution';
      readonly sourceId: string;
      readonly executionId: ExecutionId;
      readonly logResultSetId: ResultSetId;
    }
  | {
      readonly type: 'update-results';
      readonly sourceId: string;
      readonly executionId?: ExecutionId;
      readonly resultSets: ResultSetInput[];
      readonly autoPin?: ResultPinMetadata;
    }
  | {
      readonly type: 'append-streaming-chunk';
      readonly sourceId: string;
      readonly executionId?: ExecutionId;
      readonly resultSetId: ResultSetId;
      readonly chunk: StreamingChunk;
      readonly autoPin?: ResultPinMetadata;
    }
  | {
      readonly type: 'cancel-execution';
      readonly sourceId: string;
      readonly executionId?: ExecutionId;
      readonly resultSetIds?: readonly ResultSetId[];
      readonly resultSetIndices?: readonly number[];
      readonly currentRowCounts?: readonly number[];
    }
  | {
      readonly type: 'finalize-execution';
      readonly sourceId: string;
      readonly executionId?: ExecutionId;
    }
  | {
      readonly type: 'close-result';
      readonly sourceId: string;
      readonly resultSetId?: ResultSetId;
      readonly resultSetIndex?: number;
    }
  | { readonly type: 'close-source'; readonly sourceId: string }
  | { readonly type: 'set-active-source'; readonly sourceId: string }
  | {
      readonly type: 'set-active-result-set';
      readonly sourceId: string;
      readonly resultSetId?: ResultSetId;
      readonly resultSetIndex?: number;
    }
  | {
      readonly type: 'toggle-result-pin';
      readonly sourceId: string;
      readonly resultSetId?: ResultSetId;
      readonly resultSetIndex?: number;
      readonly timestamp?: number;
      readonly label?: string;
    };

export function createEmptyResultPanelState(): ResultPanelState {
  return { sources: new Map(), pinnedResults: [] };
}

function logResultSet(sourceId: string, executionId: ExecutionId, resultSetId: ResultSetId): ResultSetState {
  return {
    resultSetId,
    sourceId,
    executionId,
    isLog: true,
    columns: [],
    data: [],
    totalRowCount: 0,
    loadedRowCount: 0,
    status: 'streaming',
    limitReached: false,
  };
}

function cloneResultSet(resultSet: ResultSetState): ResultSetState {
  return {
    ...resultSet,
    columns: resultSet.columns.map(column => ({ ...column })),
    data: resultSet.data.map(row => row.slice()),
  };
}

function cloneSource(source: SourceState): SourceState {
  return {
    ...source,
    resultSets: source.resultSets.map(cloneResultSet),
  };
}

function cloneState(state: ResultPanelState): ResultPanelState {
  return {
    sources: new Map(state.sources),
    activeSourceId: state.activeSourceId,
    pinnedResults: state.pinnedResults.map(pin => ({ ...pin })),
  };
}

function sourceMatchesExecution(source: SourceState, executionId: ExecutionId | undefined): boolean {
  return executionId === undefined || source.executionId === executionId;
}

function findResultIndex(source: SourceState, resultSetId: ResultSetId | undefined, resultSetIndex: number | undefined): number {
  if (resultSetId !== undefined) {
    return source.resultSets.findIndex(resultSet => resultSet.resultSetId === resultSetId);
  }
  return resultSetIndex ?? -1;
}

function findPin(state: ResultPanelState, sourceId: string, resultSetId: ResultSetId): PinnedResultState | undefined {
  return state.pinnedResults.find(pin => pin.sourceId === sourceId && pin.resultSetId === resultSetId);
}

function syncPinIndexes(state: ResultPanelState, sourceId?: string): void {
  state.pinnedResults = state.pinnedResults.flatMap(pin => {
    if (sourceId !== undefined && pin.sourceId !== sourceId) return [pin];
    const source = state.sources.get(pin.sourceId);
    const index = source?.resultSets.findIndex(resultSet => resultSet.resultSetId === pin.resultSetId) ?? -1;
    return index >= 0 ? [{ ...pin, resultSetIndex: index }] : [];
  });
}

function syncActiveResult(source: SourceState): void {
  if (source.resultSets.length === 0) {
    source.activeResultSetIndex = 0;
    source.activeResultSetId = undefined;
    return;
  }
  source.activeResultSetIndex = Math.max(0, Math.min(source.activeResultSetIndex, source.resultSets.length - 1));
  source.activeResultSetId = source.resultSets[source.activeResultSetIndex]?.resultSetId;
}

function buildInputResult(sourceId: string, executionId: ExecutionId | undefined, input: ResultSetInput): ResultSetState {
  return {
    ...input,
    sourceId: input.sourceId ?? sourceId,
    executionId: input.executionId ?? executionId,
    isLog: false,
    columns: input.columns.map(column => ({ ...column })),
    data: input.data.map(row => row.slice()),
    loadedRowCount: input.loadedRowCount ?? input.data.length,
    status: input.status ?? (input.data.length === 0 ? 'empty' : 'complete'),
    limitReached: input.limitReached ?? false,
  };
}

function getLoadedRowCount(resultSet: ResultSetState | undefined): number {
  if (!resultSet) return 0;
  return Math.max(resultSet.loadedRowCount, resultSet.data.length);
}

/** Classifies a streaming chunk without changing state. */
export function classifyStreamingChunk(state: ResultPanelState, sourceId: string): AppendStreamingOutcome['type'] {
  const source = state.sources.get(sourceId);
  return source?.isExecuting ? 'incremental' : 'ignore';
}

/** Read-only selectors used by host and renderer adapters. */
export function getResultSets(state: ResultPanelState, sourceId: string): ResultSetState[] {
  return state.sources.get(sourceId)?.resultSets ?? [];
}

export function getActiveResultSetIndex(state: ResultPanelState, sourceId: string): number {
  return state.sources.get(sourceId)?.activeResultSetIndex ?? 0;
}

/** Applies one deterministic event without mutating the previous state. */
export function reduceResultPanelState(state: ResultPanelState, event: ResultPanelEvent): ResultPanelState {
  switch (event.type) {
    case 'start-execution': {
      const next = cloneState(state);
      const previous = state.sources.get(event.sourceId);
      const manualPins = new Set(
        state.pinnedResults
          .filter(pin => pin.sourceId === event.sourceId && !pin.automatic)
          .map(pin => pin.resultSetId),
      );
      const retained = previous?.resultSets
        .filter(resultSet => resultSet.isLog || manualPins.has(resultSet.resultSetId))
        .map(cloneResultSet) ?? [];
      const previousLog = retained.find(resultSet => resultSet.isLog);
      const log = previousLog
        ? { ...previousLog, executionId: event.executionId, status: 'streaming' as const }
        : logResultSet(event.sourceId, event.executionId, event.logResultSetId);
      const source: SourceState = {
        sourceId: event.sourceId,
        resultSets: [log, ...retained.filter(resultSet => !resultSet.isLog)],
        activeResultSetIndex: 0,
        activeResultSetId: log.resultSetId,
        isExecuting: true,
        executionId: event.executionId,
        executionEpoch: (previous?.executionEpoch ?? 0) + 1,
      };
      next.sources.set(event.sourceId, source);
      next.activeSourceId = event.sourceId;
      next.pinnedResults = next.pinnedResults.filter(pin =>
        pin.sourceId !== event.sourceId || (!pin.automatic && source.resultSets.some(resultSet => resultSet.resultSetId === pin.resultSetId)),
      );
      syncPinIndexes(next, event.sourceId);
      return next;
    }

    case 'update-results': {
      const previous = state.sources.get(event.sourceId);
      if (!previous || !sourceMatchesExecution(previous, event.executionId)) return state;
      const next = cloneState(state);
      const source = cloneSource(previous);
      const manuallyPinned = new Set(
        state.pinnedResults
          .filter(pin => pin.sourceId === event.sourceId && !pin.automatic)
          .map(pin => pin.resultSetId),
      );
      const log = source.resultSets.find(resultSet => resultSet.isLog);
      const retained = source.resultSets.filter(resultSet => !resultSet.isLog && manuallyPinned.has(resultSet.resultSetId));
      const incoming = event.resultSets.map(resultSet => buildInputResult(event.sourceId, event.executionId, resultSet));
      source.resultSets = [
        ...(log ? [log] : []),
        ...retained.filter(resultSet => !incoming.some(item => item.resultSetId === resultSet.resultSetId)),
        ...incoming,
      ];
      source.isExecuting = false;
      source.activeResultSetIndex = Math.max(0, source.resultSets.length - 1);
      syncActiveResult(source);
      next.sources.set(event.sourceId, source);
      if (event.autoPin && incoming.length > 0) {
        const resultSet = incoming[incoming.length - 1];
        if (resultSet && !findPin(next, event.sourceId, resultSet.resultSetId)) {
          const resultSetIndex = source.resultSets.indexOf(resultSet);
          next.pinnedResults.push({
            sourceId: event.sourceId,
            resultSetId: resultSet.resultSetId,
            resultSetIndex,
            timestamp: event.autoPin.timestamp,
            label: event.autoPin.label ?? `Result ${resultSetIndex}`,
            automatic: true,
          });
        }
      }
      syncPinIndexes(next, event.sourceId);
      return next;
    }

    case 'append-streaming-chunk': {
      const previous = state.sources.get(event.sourceId);
      if (!previous || !previous.isExecuting || !sourceMatchesExecution(previous, event.executionId)) return state;
      const previousIndex = findResultIndex(previous, event.resultSetId, undefined);
      const previousResult = previousIndex >= 0 ? previous.resultSets[previousIndex] : undefined;
      const chunk = event.chunk;
      if (previousResult?.lastChunkSequence !== undefined && chunk.chunkSequence !== undefined && chunk.chunkSequence <= previousResult.lastChunkSequence) return state;
      if (previousResult && chunk.fromRow !== undefined && chunk.fromRow !== getLoadedRowCount(previousResult)) return state;
      if (!chunk.isFirstChunk && !previousResult) return state;

      const next = cloneState(state);
      const source = cloneSource(previous);
      let resultSetIndex = findResultIndex(source, event.resultSetId, undefined);
      let target = resultSetIndex >= 0 ? source.resultSets[resultSetIndex] : undefined;
      if (!target) {
        resultSetIndex = source.resultSets.length;
        target = {
          resultSetId: event.resultSetId,
          sourceId: event.sourceId,
          executionId: source.executionId,
          isLog: false,
          columns: chunk.columns.map(column => ({ ...column })),
          data: [],
          totalRowCount: 0,
          loadedRowCount: 0,
          status: 'streaming',
          limitReached: false,
        };
        source.resultSets.push(target);
      }
      const previousLoadedRowCount = getLoadedRowCount(target);
      target.data = target.data.concat(chunk.rows.map(row => row.slice()));
      if (target.columns.length === 0 && chunk.columns.length > 0) target.columns = chunk.columns.map(column => ({ ...column }));
      target.totalRowCount = chunk.totalRowsSoFar;
      target.loadedRowCount = previousLoadedRowCount + chunk.rows.length;
      target.limitReached = target.limitReached || chunk.limitReached;
      target.isCancelled = target.isCancelled || chunk.isCancelled;
      target.status = target.isCancelled ? 'cancelled' : chunk.isLastChunk ? 'complete' : 'streaming';
      target.lastChunkSequence = chunk.chunkSequence ?? target.lastChunkSequence;
      source.activeResultSetIndex = resultSetIndex;
      syncActiveResult(source);
      next.sources.set(event.sourceId, source);
      if (event.autoPin && chunk.isFirstChunk && !findPin(next, event.sourceId, target.resultSetId)) {
        next.pinnedResults.push({
          sourceId: event.sourceId,
          resultSetId: target.resultSetId,
          resultSetIndex,
          timestamp: event.autoPin.timestamp,
          label: event.autoPin.label ?? `Result ${resultSetIndex}`,
          automatic: true,
        });
      }
      syncPinIndexes(next, event.sourceId);
      return next;
    }

    case 'cancel-execution': {
      const previous = state.sources.get(event.sourceId);
      if (!previous || !sourceMatchesExecution(previous, event.executionId)) return state;
      const next = cloneState(state);
      const source = cloneSource(previous);
      const ids = new Set(event.resultSetIds ?? []);
      const indices = new Set(event.resultSetIndices ?? []);
      source.resultSets = source.resultSets.map((resultSet, index) => {
        const selectedById = ids.has(resultSet.resultSetId);
        const selectedByIndex = indices.has(index);
        const hasSelection = ids.size > 0 || indices.size > 0;
        const selected = !hasSelection || selectedById || selectedByIndex;
        if (resultSet.isLog || !selected) return resultSet;
        const rowCount = event.currentRowCounts?.[index];
        const data = rowCount === undefined ? resultSet.data : resultSet.data.slice(0, rowCount);
        return {
          ...resultSet,
          data,
          loadedRowCount: rowCount ?? getLoadedRowCount(resultSet),
          totalRowCount: rowCount ?? resultSet.totalRowCount,
          isCancelled: true,
          status: 'cancelled',
        };
      });
      source.isExecuting = false;
      syncActiveResult(source);
      next.sources.set(event.sourceId, source);
      return next;
    }

    case 'finalize-execution': {
      const previous = state.sources.get(event.sourceId);
      if (!previous || !sourceMatchesExecution(previous, event.executionId)) return state;
      const next = cloneState(state);
      const source = cloneSource(previous);
      source.isExecuting = false;
      let lastDataIndex = -1;
      for (let index = source.resultSets.length - 1; index >= 0; index -= 1) {
        if (!source.resultSets[index]?.isLog) {
          lastDataIndex = index;
          break;
        }
      }
      if (lastDataIndex >= 0) source.activeResultSetIndex = lastDataIndex;
      syncActiveResult(source);
      next.sources.set(event.sourceId, source);
      next.pinnedResults = next.pinnedResults.filter(pin => pin.sourceId !== event.sourceId || !pin.automatic);
      syncPinIndexes(next, event.sourceId);
      return next;
    }

    case 'close-result': {
      const source = state.sources.get(event.sourceId);
      if (!source) return state;
      const resultSetIndex = findResultIndex(source, event.resultSetId, event.resultSetIndex);
      if (resultSetIndex < 0 || resultSetIndex >= source.resultSets.length) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      const [removed] = updated.resultSets.splice(resultSetIndex, 1);
      if (updated.activeResultSetIndex > resultSetIndex) updated.activeResultSetIndex -= 1;
      else if (updated.activeResultSetIndex === resultSetIndex) updated.activeResultSetIndex = Math.max(0, resultSetIndex - 1);
      syncActiveResult(updated);
      next.sources.set(event.sourceId, updated);
      if (removed) {
        next.pinnedResults = next.pinnedResults.filter(pin =>
          pin.sourceId !== event.sourceId || pin.resultSetId !== removed.resultSetId,
        );
      }
      syncPinIndexes(next, event.sourceId);
      return next;
    }

    case 'close-source': {
      const next = cloneState(state);
      next.sources.delete(event.sourceId);
      next.pinnedResults = next.pinnedResults.filter(pin => pin.sourceId !== event.sourceId);
      if (next.activeSourceId === event.sourceId) next.activeSourceId = next.sources.keys().next().value;
      return next;
    }

    case 'set-active-source': {
      if (!state.sources.has(event.sourceId)) return state;
      const next = cloneState(state);
      next.activeSourceId = event.sourceId;
      return next;
    }

    case 'set-active-result-set': {
      const source = state.sources.get(event.sourceId);
      if (!source) return state;
      const resultSetIndex = findResultIndex(source, event.resultSetId, event.resultSetIndex);
      if (resultSetIndex < 0 || resultSetIndex >= source.resultSets.length) return state;
      const next = cloneState(state);
      const updated = cloneSource(source);
      updated.activeResultSetIndex = resultSetIndex;
      syncActiveResult(updated);
      next.sources.set(event.sourceId, updated);
      return next;
    }

    case 'toggle-result-pin': {
      const source = state.sources.get(event.sourceId);
      if (!source) return state;
      const resultSetIndex = findResultIndex(source, event.resultSetId, event.resultSetIndex);
      const resultSet = source.resultSets[resultSetIndex];
      if (!resultSet || resultSet.isLog) return state;
      const next = cloneState(state);
      const existing = findPin(next, event.sourceId, resultSet.resultSetId);
      if (existing) {
        next.pinnedResults = next.pinnedResults.filter(pin => pin !== existing);
      } else {
        next.pinnedResults.push({
          sourceId: event.sourceId,
          resultSetId: resultSet.resultSetId,
          resultSetIndex,
          timestamp: event.timestamp ?? 0,
          label: event.label ?? `Result ${resultSetIndex}`,
          automatic: false,
        });
      }
      syncPinIndexes(next, event.sourceId);
      return next;
    }
  }
}
