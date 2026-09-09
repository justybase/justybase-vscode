import {
  classifyStreamingChunk,
  createEmptyResultPanelState,
  createResultSetId,
  ensureResultSetId,
  getActiveResultSetIndex,
  getResultSets,
  isLegacyTimestampIdentity,
  reduceResultPanelState,
  type ResultPanelState,
  type ResultSetInput,
  type StreamingChunk,
} from '../src';

function dataResult(resultSetId: string, value: number): ResultSetInput {
  return {
    resultSetId,
    columns: [{ name: 'id', type: 'int' }],
    data: [[value]],
    totalRowCount: 1,
    loadedRowCount: 1,
    status: 'complete',
    limitReached: false,
  };
}

function chunk(rows: unknown[][], totalRowsSoFar: number, overrides: Partial<StreamingChunk> = {}): StreamingChunk {
  return {
    columns: [{ name: 'id', type: 'int' }],
    rows,
    isFirstChunk: false,
    isLastChunk: false,
    totalRowsSoFar,
    limitReached: false,
    ...overrides,
  };
}

function pinFor(state: ResultPanelState, resultSetId: string) {
  return state.pinnedResults.find(pin => pin.resultSetId === resultSetId);
}

describe('result-core state contract', () => {
  it('preserves manually pinned identity across source switches and re-execution', () => {
    const sourceA = 'file:///core-a.sql';
    const sourceB = 'file:///core-b.sql';
    const executionA = 'execution-a-1';
    const executionB = 'execution-b-1';

    let state = createEmptyResultPanelState();
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceA, executionId: executionA, logResultSetId: 'a-log' });
    state = reduceResultPanelState(state, {
      type: 'update-results',
      sourceId: sourceA,
      executionId: executionA,
      resultSets: [dataResult('a-result-1', 1), dataResult('a-result-2', 2)],
      autoPin: { timestamp: 10 },
    });
    state = reduceResultPanelState(state, { type: 'toggle-result-pin', sourceId: sourceA, resultSetId: 'a-result-1', timestamp: 20, label: 'manual' });
    state = reduceResultPanelState(state, { type: 'toggle-result-pin', sourceId: sourceA, resultSetId: 'a-result-2' });
    expect(pinFor(state, 'a-result-1')?.automatic).toBe(false);
    expect(pinFor(state, 'a-result-2')).toBeUndefined();

    state = reduceResultPanelState(state, { type: 'set-active-result-set', sourceId: sourceA, resultSetId: 'a-result-2' });
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceB, executionId: executionB, logResultSetId: 'b-log' });
    state = reduceResultPanelState(state, {
      type: 'update-results',
      sourceId: sourceB,
      executionId: executionB,
      resultSets: [dataResult('b-result-1', 3)],
      autoPin: { timestamp: 30 },
    });
    state = reduceResultPanelState(state, { type: 'set-active-source', sourceId: sourceA });
    expect(getActiveResultSetIndex(state, sourceA)).toBe(2);

    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceA, executionId: 'execution-a-2', logResultSetId: 'a-log-2' });
    expect(getResultSets(state, sourceA).map(result => result.resultSetId)).toEqual(['a-log', 'a-result-1']);
    expect(pinFor(state, 'a-result-1')?.label).toBe('manual');
    expect(getResultSets(state, sourceB).map(result => result.resultSetId)).toContain('b-result-1');
  });

  it('shifts pin indexes while keeping the pinned result identity', () => {
    const sourceId = 'file:///core-close.sql';
    let state = reduceResultPanelState(createEmptyResultPanelState(), {
      type: 'start-execution', sourceId, executionId: 'execution-close', logResultSetId: 'close-log',
    });
    state = reduceResultPanelState(state, {
      type: 'update-results', sourceId, executionId: 'execution-close',
      resultSets: [dataResult('first', 1), dataResult('second', 2)], autoPin: { timestamp: 1 },
    });
    state = reduceResultPanelState(state, { type: 'close-result', sourceId, resultSetId: 'first' });

    expect(getResultSets(state, sourceId).map(result => result.resultSetId)).toEqual(['close-log', 'second']);
    expect(pinFor(state, 'second')?.resultSetIndex).toBe(1);
    expect(getActiveResultSetIndex(state, sourceId)).toBe(1);
  });

  it('removes a closed pin only from the matching source', () => {
    const sourceA = 'file:///core-shared-id-a.sql';
    const sourceB = 'file:///core-shared-id-b.sql';
    const sharedResultSetId = 'shared-result-id';
    let state = createEmptyResultPanelState();

    state = reduceResultPanelState(state, {
      type: 'start-execution', sourceId: sourceA, executionId: 'execution-shared-a', logResultSetId: 'a-log',
    });
    state = reduceResultPanelState(state, {
      type: 'update-results', sourceId: sourceA, executionId: 'execution-shared-a',
      resultSets: [dataResult(sharedResultSetId, 1)], autoPin: { timestamp: 1 },
    });
    state = reduceResultPanelState(state, {
      type: 'start-execution', sourceId: sourceB, executionId: 'execution-shared-b', logResultSetId: 'b-log',
    });
    state = reduceResultPanelState(state, {
      type: 'update-results', sourceId: sourceB, executionId: 'execution-shared-b',
      resultSets: [dataResult(sharedResultSetId, 2)], autoPin: { timestamp: 2 },
    });

    state = reduceResultPanelState(state, {
      type: 'close-result', sourceId: sourceA, resultSetId: sharedResultSetId,
    });

    expect(state.pinnedResults).toEqual([
      expect.objectContaining({ sourceId: sourceB, resultSetId: sharedResultSetId }),
    ]);
  });

  it('appends every streaming chunk to one result and ignores late delivery after cancel', () => {
    const sourceId = 'file:///core-stream.sql';
    const executionId = 'execution-stream';
    let state = reduceResultPanelState(createEmptyResultPanelState(), {
      type: 'start-execution', sourceId, executionId, logResultSetId: 'stream-log',
    });
    expect(classifyStreamingChunk(state, sourceId)).toBe('incremental');

    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk', sourceId, executionId, resultSetId: 'stream-result',
      chunk: chunk([[1], [2]], 2, { isFirstChunk: true, chunkSequence: 1 }),
    });
    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk', sourceId, executionId, resultSetId: 'stream-result',
      chunk: chunk([[3]], 3, { fromRow: 2, chunkSequence: 2 }),
    });
    expect(getResultSets(state, sourceId)[1]?.data).toEqual([[1], [2], [3]]);

    const beforeDuplicate = state;
    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk', sourceId, executionId, resultSetId: 'stream-result',
      chunk: chunk([[3]], 3, { fromRow: 2, chunkSequence: 2 }),
    });
    expect(state).toBe(beforeDuplicate);

    state = reduceResultPanelState(state, {
      type: 'cancel-execution', sourceId, executionId, resultSetIds: ['stream-result'], currentRowCounts: [0, 2],
    });
    expect(classifyStreamingChunk(state, sourceId)).toBe('ignore');
    expect(getResultSets(state, sourceId)[1]?.status).toBe('cancelled');
    expect(getResultSets(state, sourceId)[1]?.data).toHaveLength(2);

    const beforeLate = state;
    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk', sourceId, executionId, resultSetId: 'stream-result',
      chunk: chunk([[4]], 4, { isLastChunk: true, fromRow: 2, chunkSequence: 3 }),
    });
    expect(state).toBe(beforeLate);
  });

  it('validates offsets against loaded counts when the adapter has no row buffer', () => {
    const sourceId = 'file:///core-window.sql';
    const executionId = 'execution-window';
    let state = reduceResultPanelState(createEmptyResultPanelState(), {
      type: 'start-execution', sourceId, executionId, logResultSetId: 'window-log',
    });
    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk', sourceId, executionId, resultSetId: 'window-result',
      chunk: chunk([[1], [2]], 2, { isFirstChunk: true, chunkSequence: 1 }),
    });
    state = reduceResultPanelState({
      ...state,
      sources: new Map(state.sources).set(sourceId, {
        ...state.sources.get(sourceId)!,
        resultSets: state.sources.get(sourceId)!.resultSets.map(resultSet => resultSet.resultSetId === 'window-result'
          ? { ...resultSet, data: [], loadedRowCount: 2, lastChunkSequence: 1 }
          : resultSet),
      }),
    }, {
      type: 'append-streaming-chunk', sourceId, executionId, resultSetId: 'window-result',
      chunk: chunk([[3]], 3, { fromRow: 2, chunkSequence: 2 }),
    });
    expect(getResultSets(state, sourceId)[1]).toMatchObject({ loadedRowCount: 3, lastChunkSequence: 2 });
  });

  it('finalizes execution by removing automatic pins and keeps source cleanup isolated', () => {
    const sourceA = 'file:///core-remove-a.sql';
    const sourceB = 'file:///core-remove-b.sql';
    let state = createEmptyResultPanelState();
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceA, executionId: 'execution-a', logResultSetId: 'a-log' });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceA, executionId: 'execution-a', resultSets: [dataResult('a-result', 1)], autoPin: { timestamp: 1 } });
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceB, executionId: 'execution-b', logResultSetId: 'b-log' });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceB, executionId: 'execution-b', resultSets: [dataResult('b-result', 2)], autoPin: { timestamp: 2 } });
    state = reduceResultPanelState(state, { type: 'finalize-execution', sourceId: sourceB, executionId: 'execution-b' });
    expect(pinFor(state, 'b-result')).toBeUndefined();

    state = reduceResultPanelState(state, { type: 'set-active-source', sourceId: sourceA });
    state = reduceResultPanelState(state, { type: 'close-source', sourceId: sourceA });
    expect(state.sources.has(sourceA)).toBe(false);
    expect(state.pinnedResults.some(pin => pin.sourceId === sourceA)).toBe(false);
    expect(state.activeSourceId).toBe(sourceB);
    expect(getResultSets(state, sourceB).map(result => result.resultSetId)).toContain('b-result');
  });
});

describe('result-core identity', () => {
  it('mints stable ids, detects legacy ids and does not mutate inputs', () => {
    const first = createResultSetId();
    const second = createResultSetId();
    expect(first).toMatch(/^result-set-/u);
    expect(second).not.toBe(first);
    expect(isLegacyTimestampIdentity(first)).toBe(false);
    expect(isLegacyTimestampIdentity('1699999999999')).toBe(true);

    const input = { name: 'x' };
    const resultSet = ensureResultSetId(input);
    expect(resultSet.resultSetId).toMatch(/^result-set-/u);
    expect(input).toEqual({ name: 'x' });
  });
});
