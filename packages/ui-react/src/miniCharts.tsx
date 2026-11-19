import type { ReactNode } from 'react';
import type { DataGridColumn } from './dataGridTypes';
import { isDataGridNumericColumn } from './resultGridFormatting';

export interface MiniChartsViewProps {
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly title?: string;
}

const MINI_CHART_SAMPLE = 120;
const MAX_MINI_CHARTS = 16;

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number.parseFloat(String(value).replace(/,/gu, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function isNumericColumn(column: DataGridColumn, columnIndex: number, rows: readonly (readonly unknown[])[]): boolean {
  if (isDataGridNumericColumn(column)) return true;
  const sample = Math.min(rows.length, MINI_CHART_SAMPLE);
  let nonNull = 0;
  let numeric = 0;
  for (let index = 0; index < sample; index += 1) {
    const value = rows[index]?.[columnIndex];
    if (value === null || value === undefined || value === '') continue;
    nonNull += 1;
    if (parseNumeric(value) !== null) numeric += 1;
  }
  return nonNull > 0 && numeric / nonNull >= 0.7;
}

function sparklinePath(values: readonly number[], width: number, height: number, padding: number): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  return values.map((value, index) => {
    const x = padding + (index / Math.max(values.length - 1, 1)) * innerWidth;
    const y = padding + (1 - (value - min) / range) * innerHeight;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

/**
 * Legacy "Mini Charts" layout: one sparkline per numeric column, sampled from
 * the first 120 non-null values so the overview stays instant on large results.
 */
export function MiniChartsView({ columns, rows, title = 'Mini Charts' }: MiniChartsViewProps): ReactNode {
  const indexed = columns.map((column, index) => ({ column, index }));
  const numeric = indexed
    .filter(item => isNumericColumn(item.column, item.index, rows))
    .slice(0, MAX_MINI_CHARTS);
  return <section className="ui-mini-charts" aria-label={title}>
    <header className="ui-mini-charts-header">
      <h2>{title}</h2>
      <span>{numeric.length.toLocaleString()} numeric column{numeric.length === 1 ? '' : 's'} · sampling up to {MINI_CHART_SAMPLE.toLocaleString()} rows</span>
    </header>
    {numeric.length === 0
      ? <div className="ui-mini-charts-empty">No numeric columns available for mini charts.</div>
      : <div className="ui-mini-charts-grid">
        {numeric.map(({ column, index }) => {
          const values: number[] = [];
          for (let row = 0; row < rows.length && values.length < MINI_CHART_SAMPLE; row += 1) {
            const value = parseNumeric(rows[row]?.[index]);
            if (value !== null) values.push(value);
          }
          const min = values.length > 0 ? Math.min(...values) : undefined;
          const max = values.length > 0 ? Math.max(...values) : undefined;
          const avg = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
          return <article className="ui-mini-chart-card" key={`${column.name}:${index}`}>
            <div className="ui-mini-chart-title" title={`${column.name}${column.type ? ` · ${column.type}` : ''}`}>{column.name}</div>
            {values.length === 0
              ? <div className="ui-mini-chart-empty">Not enough numeric values</div>
              : <>
                <div className="ui-mini-chart-sparkline">
                  <svg viewBox="0 0 170 42" preserveAspectRatio="none" role="img" aria-label={`${column.name} trend`}>
                    <path d={sparklinePath(values, 170, 42, 4)} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="ui-mini-chart-meta">
                  min {formatNumber(min!)} • avg {formatNumber(avg!)} • max {formatNumber(max!)}
                </div>
                <div className="ui-mini-chart-last" title="Latest sampled value">
                  last {formatNumber(values[values.length - 1]!)}
                </div>
              </>}
          </article>;
        })}
      </div>}
  </section>;
}
