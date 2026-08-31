import {
  parseQueryAggregateRequest,
  parseQueryGroupRequest,
  parseQueryPageRequest,
  parseQueryStartRequest,
  RequestValidationError,
} from '../src/requestValidation';

describe('API request validation', () => {
  it('rejects non-object and oversized query payloads before planning SQL', () => {
    expect(() => parseQueryStartRequest(null)).toThrow(RequestValidationError);
    expect(() => parseQueryStartRequest({ connectionId: 'c', sql: '' })).toThrow('sql is required');
    expect(() => parseQueryStartRequest({ connectionId: 'c', sql: 'SELECT 1', mode: 'unknown' })).toThrow('mode must be single');
    expect(() => parseQueryStartRequest({ connectionId: 'c', sql: 'SELECT 1', maxRows: 0 })).toThrow('maxRows must be an integer');
  });

  it('normalizes valid paging input while bounding page size', () => {
    expect(parseQueryPageRequest({ offset: 10, limit: 1000, globalFilter: '  Alpha  ', sorting: [{ columnIndex: 1, desc: true }] })).toEqual({
      statementIndex: undefined,
      offset: 10,
      limit: 1000,
      globalFilter: 'Alpha',
      columnFilters: undefined,
      sorting: [{ columnIndex: 1, desc: true }],
    });
    expect(() => parseQueryPageRequest({ limit: 1001 })).toThrow('limit must be an integer from 1 to 1000');
    expect(() => parseQueryPageRequest({ sorting: [{ columnIndex: 0, desc: 'yes' }] })).toThrow('desc must be a boolean');
  });

  it('preserves SQL whitespace used by editor offsets', () => {
    const request = parseQueryStartRequest({ connectionId: 'c', sql: '  SELECT 1\n', cursorOffset: 3 });
    expect(request.sql).toBe('  SELECT 1\n');
    expect(request.cursorOffset).toBe(3);
  });

  it('validates aggregate and grouping function names and indices', () => {
    expect(parseQueryAggregateRequest({ functions: ['sum'], columnIndices: [2] })).toEqual(expect.objectContaining({ functions: ['sum'], columnIndices: [2] }));
    expect(() => parseQueryAggregateRequest({ functions: ['drop'] })).toThrow('not supported');
    expect(() => parseQueryGroupRequest({ groupByColumnIndices: [], aggregates: [{ function: 'count' }] })).toThrow('at least one column');
    expect(() => parseQueryGroupRequest({ groupByColumnIndices: [0], aggregates: [{ function: 'drop' }] })).toThrow('not supported');
  });
});
