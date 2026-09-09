import {
  aggregateResultRows,
  filterResultRowIndexes,
  filterResultRows,
  type ResultColumn,
} from '../src';
import { parseDecimal } from '../src/operations';

const columns: ResultColumn[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'amount', type: 'DECIMAL' },
  { name: 'label', type: 'VARCHAR' },
];

describe('result-core filtering', () => {
  const rows: unknown[][] = [
    ['9007199254740993', '0.10', 'Alpha'],
    ['9007199254740994', '0.20', null],
    [null, '10.00', 'Beta'],
  ];

  it('matches NULL, large exact numeric values and global search', () => {
    expect(filterResultRowIndexes(rows, columns, {
      columnFilters: [{ columnIndex: 0, value: { _isConditionFilter: true, logic: 'and', conditions: [{ type: 'equals', value: '9007199254740993' }] } }],
    })).toEqual([0]);
    expect(filterResultRows(rows, columns, {
      columnFilters: [{ columnIndex: 2, value: ['NULL'] }],
    })).toEqual([rows[1]]);
    expect(filterResultRowIndexes(rows, columns, { globalFilter: 'beta' })).toEqual([2]);
  });

  it('supports AND/OR conditions and preserves row order', () => {
    expect(filterResultRowIndexes(rows, columns, {
      columnFilters: [{
        columnIndex: 1,
        value: {
          _isConditionFilter: true,
          logic: 'or',
          conditions: [
            { type: 'lessThan', value: '0.2' },
            { type: 'greaterThan', value: '9' },
          ],
        },
      }],
    })).toEqual([0, 2]);
  });

  it('rejects extreme exponents before decimal arithmetic allocates a huge bigint', () => {
    expect(parseDecimal('1e999999999')).toBeNull();
    expect(() => filterResultRowIndexes([[1]], [{ name: 'id', type: 'BIGINT' }], {
      columnFilters: [{
        columnIndex: 0,
        value: {
          _isConditionFilter: true,
          logic: 'and',
          conditions: [{ type: 'greaterThan', value: '1e999999999' }],
        },
      }],
    })).not.toThrow();
  });
});

describe('result-core exact aggregation', () => {
  it('keeps decimal and bigint arithmetic out of Number', () => {
    const result = aggregateResultRows([
      ['9007199254740993', '0.10'],
      ['9007199254740994', '0.20'],
      [null, null],
    ], [
      { columnIndex: 0, function: 'sum' },
      { columnIndex: 1, function: 'sum' },
      { columnIndex: 1, function: 'avg', precision: 4 },
    ]);

    expect(result.map(item => item.value)).toEqual(['18014398509481987', '0.3', '0.15']);
  });

  it('handles NULL counts, median, min/max and population standard deviation', () => {
    const result = aggregateResultRows([[1], [2], [3], [null]], [
      { columnIndex: 0, function: 'count' },
      { columnIndex: 0, function: 'countDistinct' },
      { columnIndex: 0, function: 'min' },
      { columnIndex: 0, function: 'max' },
      { columnIndex: 0, function: 'median' },
      { columnIndex: 0, function: 'stdev', precision: 6 },
    ]);

    expect(result.map(item => item.value)).toEqual([3, 3, '1', '3', '2', '0.816497']);
  });

  it('canonicalizes equivalent numeric representations for count distinct', () => {
    const result = aggregateResultRows([
      ['1.0'],
      ['1.00'],
      ['1.01'],
    ], [{ columnIndex: 0, function: 'countDistinct', dataType: 'DECIMAL', scale: 2 }]);

    expect(result[0]?.value).toBe(2);
    expect(aggregateResultRows([['1.0'], ['1.00']], [{ columnIndex: 0, function: 'countDistinct' }])[0]?.value).toBe(1);
  });

  it('keeps standard deviation linear for a large input', () => {
    const rows = Array.from({ length: 50_000 }, (_, index) => [index]);
    const started = process.hrtime.bigint();
    const result = aggregateResultRows(rows, [{ columnIndex: 0, function: 'stdev', precision: 6 }]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(Number(result[0]?.value)).toBeCloseTo(14_433.7567297, 4);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('returns null for numeric aggregates over an empty set', () => {
    expect(aggregateResultRows([[null]], [
      { columnIndex: 0, function: 'sum' },
      { columnIndex: 0, function: 'avg' },
    ]).map(item => item.value)).toEqual([null, null]);
  });
});
