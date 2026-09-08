import {
  createEmptyResultPanelState,
  createResultSetId,
  ensureResultSetId,
  getActiveResultSetIndex,
  getResultSets,
  isLegacyTimestampIdentity,
  reduceResultPanelState,
  type ResultPanelState,
  type ResultSetState,
  type StreamingChunk,
} from '../src';

function dataResult(resultSetId: string, value: number): Omit<ResultSetState, 'isLog'> {
  return {
    resultSetId,
    columns: [{ name: 'id', type: 'int' }],
    data: [[value]],
    totalRowCount: 1,
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

function pinFor(state: ResultPanelState, sourceId: string, resultSetIndex: number) {
  return state.pinnedResults.find(pin => pin.sourceId === sourceId && pin.resultSetIndex === resultSetIndex);
}

describe('result-core state contract (frozen transitions)', () => {
  it('preserves identity and manually pinned results across source switches and re-execution', () => {
    const sourceA = 'file:///core-a.sql';
    const sourceB = 'file:///core-b.sql';

    let state = createEmptyResultPanelState();
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceA });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceA, resultSets: [dataResult('a-result-1', 1), dataResult('a-result-2', 2)] });

    // update-results auto-pins the last delivered result; replace it with a manual pin.
    expect(pinFor(state, sourceA, 2)).toBeDefined();
    state = reduceResultPanelState(state, { type: 'toggle-result-pin', sourceId: sourceA, resultSetIndex: 2 });
    expect(pinFor(state, sourceA, 2)).toBeUndefined();
    state = reduceResultPanelState(state, { type: 'toggle-result-pin', sourceId: sourceA, resultSetIndex: 2, label: 'manual' });
    expect(pinFor(state, sourceA, 2)?.label).toBe('manual');

    state = reduceResultPanelState(state, { type: 'set-active-result-set-index', sourceId: sourceA, resultSetIndex: 5 });
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceB });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceB, resultSets: [dataResult('b-result-1', 3)] });
    expect(state.activeSourceId).toBe(sourceB);

    state = reduceResultPanelState(state, { type: 'set-active-source', sourceId: sourceA });
    expect(getActiveResultSetIndex(state, sourceA)).toBe(5);

    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceA });
    const results = getResultSets(state, sourceA);
    expect(results[0]?.isLog).toBe(true);
    expect(results.map(result => result.resultSetId)).not.toContain('a-result-1');
    expect(results.map(result => result.resultSetId)).not.toContain('a-result-2');
    expect(getActiveResultSetIndex(state, sourceA)).toBe(1);
    // The manual pin survives re-execution by source + index.
    expect(pinFor(state, sourceA, 2)?.label).toBe('manual');
    // The other source is untouched.
    expect(getResultSets(state, sourceB).map(result => result.resultSetId)).toContain('b-result-1');
  });

  it('shifts pinned and active indices when a result is closed', () => {
    const sourceUri = 'file:///core-close.sql';

    let state = createEmptyResultPanelState();
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceUri });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceUri, resultSets: [dataResult('first', 1), dataResult('second', 2)] });
    // [log, first, second] with an automatic pin on 'second' (index 2).
    expect(pinFor(state, sourceUri, 2)).toBeDefined();
    expect(getActiveResultSetIndex(state, sourceUri)).toBe(3);

    state = reduceResultPanelState(state, { type: 'close-result', sourceId: sourceUri, resultSetIndex: 1 });

    const results = getResultSets(state, sourceUri);
    expect(results[1]?.resultSetId).toBe('second');
    expect(getActiveResultSetIndex(state, sourceUri)).toBe(2);
    // The pin follows the surviving result to its shifted index (2 -> 1).
    expect(pinFor(state, sourceUri, 1)?.resultSetIndex).toBe(1);
    expect(pinFor(state, sourceUri, 2)).toBeUndefined();
  });

  it('keeps partial streaming data marked cancelled and ignores late chunks', () => {
    const sourceUri = 'file:///core-stream.sql';

    let state = createEmptyResultPanelState();
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceUri });

    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk',
      sourceId: sourceUri,
      chunk: chunk([[1], [2]], 2, { isFirstChunk: true }),
    });
    expect(getResultSets(state, sourceUri)[1]?.data).toEqual([[1], [2]]);

    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk',
      sourceId: sourceUri,
      chunk: chunk([[3]], 3),
    });

    state = reduceResultPanelState(state, { type: 'cancel-execution', sourceId: sourceUri, resultSetIndices: [1] });

    const result = getResultSets(state, sourceUri)[1];
    expect(result?.isCancelled).toBe(true);
    expect(result?.data).toHaveLength(2);
    expect(result?.totalRowCount).toBe(2);
    expect(state.sources.get(sourceUri)?.isExecuting).toBe(false);

    const before = state;
    state = reduceResultPanelState(state, {
      type: 'append-streaming-chunk',
      sourceId: sourceUri,
      chunk: chunk([[4]], 4, { isLastChunk: true }),
    });
    expect(state).toBe(before);
    expect(getResultSets(state, sourceUri)).toHaveLength(3);
  });

  it('removes source-owned state and selects a surviving source on close', () => {
    const sourceA = 'file:///core-remove-a.sql';
    const sourceB = 'file:///core-remove-b.sql';

    let state = createEmptyResultPanelState();
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceA });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceA, resultSets: [dataResult('a-result', 1)] });
    state = reduceResultPanelState(state, { type: 'start-execution', sourceId: sourceB });
    state = reduceResultPanelState(state, { type: 'update-results', sourceId: sourceB, resultSets: [dataResult('b-result', 2)] });

    state = reduceResultPanelState(state, { type: 'set-active-source', sourceId: sourceA });
    state = reduceResultPanelState(state, { type: 'close-source', sourceId: sourceA });

    expect(state.sources.has(sourceA)).toBe(false);
    expect(state.pinnedResults.some(pin => pin.sourceId === sourceA)).toBe(false);
    expect(state.activeSourceId).toBe(sourceB);
    expect(getResultSets(state, sourceB).map(result => result.resultSetId)).toContain('b-result');
  });
});

describe('result-core identity', () => {
  it('mints stable ids with a collision guard and detects legacy ids', () => {
    const first = createResultSetId();
    const second = createResultSetId();
    expect(first).toMatch(/^result-set-/u);
    expect(second).not.toBe(first);
    expect(isLegacyTimestampIdentity(first)).toBe(false);
    expect(isLegacyTimestampIdentity('1699999999999')).toBe(true);

    const resultSet = ensureResultSetId({ name: 'x' });
    expect(resultSet.resultSetId).toMatch(/^result-set-/u);
  });
});