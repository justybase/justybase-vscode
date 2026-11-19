import type { UiResultAggregationFunction, UiResultColumnAggregation } from '@justybase/ui-core';
import type { DataGridColumn } from './dataGridTypes';
import { formatDataGridCellValue } from './resultGridFormatting';

const AGGREGATION_LABELS: Record<UiResultAggregationFunction, string> = {
  sum: 'Σ',
  count: '#',
  countDistinct: 'D',
  avg: 'μ',
  min: 'min',
  max: 'max',
  stdev: 'σ',
  median: 'M',
};

export const AGGREGATION_FUNCTION_LABELS: Record<UiResultAggregationFunction, string> = {
  sum: 'Sum',
  count: 'Count',
  countDistinct: 'Count distinct',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  stdev: 'Std deviation',
  median: 'Median',
};

export interface DataGridAggregationCell {
  readonly fn: UiResultAggregationFunction;
  readonly label: string;
  readonly value: string;
  readonly alignRight: boolean;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/[\s\u00A0,]/gu, '').replace(',', '.');
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function formatAggregate(value: unknown, column: DataGridColumn): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value) && Math.abs(value) < 1e15) return value.toLocaleString();
    const rounded = Math.round(value * 10_000) / 10_000;
    return rounded.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return formatDataGridCellValue(value, column.type, {
    scale: column.scale,
    inferredNumericKind: column.inferredNumericKind,
    inferredDateInteger: column.inferredDateInteger,
  });
}

function countDistinct(values: readonly unknown[]): number {
  const seen = new Set<string>();
  values.forEach(value => {
    if (isEmpty(value)) return;
    try {
      seen.add(JSON.stringify(value) ?? String(value));
    } catch {
      seen.add(String(value));
    }
  });
  return seen.size;
}

/**
 * Computes Excel-style footer statistics over the loaded rows visible in the
 * current filtered/sorted view. Aggregations are renderer-neutral so the same
 * values can be shown by the React grid, a web shell and the VS Code panel.
 */
export function calculateDataGridAggregations(
  column: DataGridColumn,
  columnIndex: number,
  rows: readonly (readonly unknown[])[],
  aggregations: readonly UiResultColumnAggregation[],
): readonly DataGridAggregationCell[] {
  if (aggregations.length === 0) return [];
  const values = rows.map(row => row[columnIndex]);
  const present = values.filter(value => !isEmpty(value));
  const numbers = present.map(numericValue).filter((value): value is number => value !== undefined);
  return aggregations.map(aggregation => {
    const fn = aggregation.fn;
    if (fn === 'count') {
      return { fn, label: AGGREGATION_LABELS[fn], value: present.length.toLocaleString(), alignRight: true };
    }
    if (fn === 'countDistinct') {
      return { fn, label: AGGREGATION_LABELS[fn], value: countDistinct(present).toLocaleString(), alignRight: true };
    }
    if (numbers.length === 0) {
      return { fn, label: AGGREGATION_LABELS[fn], value: '', alignRight: false };
    }
    if (fn === 'sum' || fn === 'avg') {
      const total = numbers.reduce((sum, value) => sum + value, 0);
      return {
        fn,
        label: AGGREGATION_LABELS[fn],
        value: formatAggregate(fn === 'sum' ? total : total / numbers.length, column),
        alignRight: true,
      };
    }
    if (fn === 'min' || fn === 'max') {
      const sorted = [...numbers].sort((left, right) => left - right);
      return {
        fn,
        label: AGGREGATION_LABELS[fn],
        value: formatAggregate(fn === 'min' ? sorted[0] : sorted[sorted.length - 1], column),
        alignRight: true,
      };
    }
    if (fn === 'median') {
      const sorted = [...numbers].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? ((sorted[middle - 1]! + sorted[middle]!) / 2)
        : sorted[middle]!;
      return { fn, label: AGGREGATION_LABELS[fn], value: formatAggregate(median, column), alignRight: true };
    }
    const average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    const variance = numbers.reduce((sum, value) => sum + (value - average) ** 2, 0) / numbers.length;
    return {
      fn,
      label: AGGREGATION_LABELS[fn],
      value: formatAggregate(Math.sqrt(variance), column),
      alignRight: true,
    };
  });
}

export { AGGREGATION_LABELS };
