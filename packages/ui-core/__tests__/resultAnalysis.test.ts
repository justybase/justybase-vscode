import type { QueryAggregateResponse, QueryGroupResponse } from '@justybase/contracts';
import { createAggregateAnalysisTable, createGroupAnalysisTable, createPivotAnalysisTable } from '../src/resultAnalysis';

const columns = [
  { name: 'CATEGORY', type: 'VARCHAR(32)' },
  { name: 'AMOUNT', type: 'NUMERIC(18,2)', scale: 2 },
];

describe('portable result analysis tables', () => {
  it('preserves aggregate nulls and exact numeric strings', () => {
    const response: QueryAggregateResponse = {
      filteredRowCount: 3,
      values: [{ columnIndex: 1, count: 2, sum: '9007199254740993.25', avg: '4503599627370496.625', min: '1.25', max: null }],
    };
    expect(createAggregateAnalysisTable(columns, response)).toMatchObject({
      kind: 'aggregate',
      rows: [['AMOUNT', 2, '9007199254740993.25', '4503599627370496.625', '1.25', null]],
    });
  });

  it('maps grouped columns and creates deterministic pivot columns', () => {
    const response: QueryGroupResponse = {
      columns: [{ name: 'CATEGORY', type: 'VARCHAR(32)' }, { name: 'PIVOT', type: 'VARCHAR(8)' }, { name: 'SUM(AMOUNT)', type: 'DECIMAL', scale: 2 }],
      rows: [['B', 'Y', '2.00'], ['A', 'X', '1.00'], ['A', 'Y', null]],
      totalGroups: 3,
    };
    expect(createGroupAnalysisTable(response).rows).toEqual(response.rows);
    expect(createGroupAnalysisTable(response).summary).toBe('3 groups');
    expect(createPivotAnalysisTable(columns, response, 0, 1, 1)).toMatchObject({
      kind: 'pivot',
      columns: [{ name: 'CATEGORY' }, { name: 'Y', type: 'NUMERIC(18,2)', scale: 2 }, { name: 'X', type: 'NUMERIC(18,2)', scale: 2 }],
      rows: [['B', '2.00', null], ['A', null, '1.00']],
    });
  });

  it('marks truncated group and pivot output with first-of totals', () => {
    const response: QueryGroupResponse = {
      columns: [{ name: 'CATEGORY' }, { name: 'PIVOT' }, { name: 'SUM(AMOUNT)', type: 'DECIMAL' }],
      rows: [['A', 'X', '1.00']],
      totalGroups: 10_000,
    };
    expect(createGroupAnalysisTable(response).summary).toBe('First 1 of 10,000 groups');
    expect(createPivotAnalysisTable(columns, response, 0, 1, 1).summary).toContain('first 1 of 10,000 groups');

    const wide: QueryGroupResponse = {
      columns: [{ name: 'ROW' }, { name: 'PIVOT' }, { name: 'SUM(V)', type: 'DECIMAL' }],
      rows: Array.from({ length: 600 }, (_, index) => ['r', `p${index}`, '1']),
      totalGroups: 600,
    };
    const capped = createPivotAnalysisTable(columns, wide, 0, 1, 1);
    expect(capped.columns).toHaveLength(501);
    expect(capped.summary).toContain('first 500 of 600 pivot values');
  });
});
