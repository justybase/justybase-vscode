import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { DataGridColumn } from './dataGridTypes';
import { formatDataGridCellValue } from './resultGridFormatting';

export interface DiffBaseline {
  readonly id: string;
  readonly label: string;
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface DiffViewProps {
  readonly target: {
    readonly label: string;
    readonly columns: readonly DataGridColumn[];
    readonly rows: readonly (readonly unknown[])[];
  };
  readonly baselines: readonly DiffBaseline[];
  readonly baselineId?: string;
  readonly onBaselineChange: (id: string) => void;
}

const MAX_DIFF_ROWS = 500;

type DiffRowType = 'added' | 'removed' | 'changed';

interface DiffCell {
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

interface DiffRow {
  readonly rowIndex: number;
  readonly type: DiffRowType;
  readonly cells: readonly DiffCell[];
}

interface DiffResult {
  readonly columns: readonly DataGridColumn[];
  readonly rows: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly truncated: boolean;
  readonly compatibilityNote?: string;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function display(value: unknown, column: DataGridColumn | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return formatDataGridCellValue(value, column?.type, column);
}

export interface DiffOptions {
  readonly ignoreCase?: boolean;
  readonly ignoreWhitespace?: boolean;
}

function normalizeForComparison(value: string, options: DiffOptions): string {
  let text = options.ignoreWhitespace ? value.replace(/\s+/gu, ' ').trim() : value;
  if (options.ignoreCase) text = text.toLocaleLowerCase();
  return text;
}

function buildDiff(baseline: DiffBaseline, target: DiffViewProps['target'], options: DiffOptions = {}): DiffResult {
  const baseByName = new Map(baseline.columns.map((column, index) => [normalizeName(column.name), { column, index }]));
  const mappings = target.columns.flatMap((column, targetIndex) => {
    const byName = baseByName.get(normalizeName(column.name));
    const baseIndex = byName?.index ?? (targetIndex < baseline.columns.length ? targetIndex : undefined);
    if (baseIndex === undefined) return [];
    return [{ target: column, targetIndex, base: baseline.columns[baseIndex]!, baseIndex }];
  });
  const sameLayout = baseline.columns.length === target.columns.length
    && target.columns.every((column, index) => normalizeName(column.name) === normalizeName(baseline.columns[index]?.name ?? ''));
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  const maxRows = Math.max(baseline.rows.length, target.rows.length);
  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const beforeRow = baseline.rows[rowIndex];
    const afterRow = target.rows[rowIndex];
    if (!beforeRow && !afterRow) continue;
    if (!beforeRow && afterRow) {
      added += 1;
      rows.push({
        rowIndex,
        type: 'added',
        cells: mappings.map(mapping => ({ before: '', after: display(afterRow[mapping.targetIndex], mapping.target), changed: true })),
      });
      continue;
    }
    if (beforeRow && !afterRow) {
      removed += 1;
      rows.push({
        rowIndex,
        type: 'removed',
        cells: mappings.map(mapping => ({ before: display(beforeRow[mapping.baseIndex], mapping.base), after: '', changed: true })),
      });
      continue;
    }
    const cells = mappings.map(mapping => {
      const before = display(beforeRow![mapping.baseIndex], mapping.base);
      const after = display(afterRow![mapping.targetIndex], mapping.target);
      return { before, after, changed: normalizeForComparison(before, options) !== normalizeForComparison(after, options) };
    });
    if (cells.some(cell => cell.changed)) {
      changed += 1;
      rows.push({ rowIndex, type: 'changed', cells });
    }
  }
  return {
    columns: mappings.map(mapping => mapping.target),
    rows: rows.slice(0, MAX_DIFF_ROWS),
    added,
    removed,
    changed,
    truncated: rows.length > MAX_DIFF_ROWS,
    compatibilityNote: sameLayout ? undefined : 'Column layouts differ. Diff mapping used matching names and fallback by position.',
  };
}

/** Result-set comparison matching the legacy Diff view (row-by-row, changed cells shown before/after). */
export function DiffView({ target, baselines, baselineId, onBaselineChange }: DiffViewProps): ReactNode {
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const baseline = baselines.find(item => item.id === baselineId) ?? baselines[0];
  const diff = useMemo(
    () => baseline ? buildDiff(baseline, target, { ignoreCase, ignoreWhitespace }) : undefined,
    [baseline, ignoreCase, ignoreWhitespace, target],
  );
  return <section className="ui-diff-view" aria-label="Diff Results">
    <header className="ui-diff-header">
      <div className="ui-diff-title">
        <h2>Diff Results</h2>
        <span>{baseline ? `${baseline.label} → ${target.label}` : 'Choose a baseline result set to compare against the active result.'}</span>
      </div>
      <div className="ui-diff-options">
        <label><input type="checkbox" checked={ignoreCase} onChange={event => setIgnoreCase(event.target.checked)} /> Ignore case</label>
        <label><input type="checkbox" checked={ignoreWhitespace} onChange={event => setIgnoreWhitespace(event.target.checked)} /> Ignore whitespace</label>
      </div>
      <label>
        <span>Baseline</span>
        <select
          aria-label="Diff baseline"
          value={baseline?.id ?? ''}
          disabled={baselines.length === 0}
          onChange={event => onBaselineChange(event.target.value)}
        >
          {baselines.length === 0 && <option value="">No comparable result sets</option>}
          {baselines.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
    </header>
    {!diff
      ? <div className="ui-diff-empty">No baseline result set selected.</div>
      : <>
        <div className="ui-diff-summary">
          Added: {diff.added.toLocaleString()} • Removed: {diff.removed.toLocaleString()} • Changed: {diff.changed.toLocaleString()}
        </div>
        {diff.compatibilityNote && <div className="ui-diff-note">{diff.compatibilityNote}</div>}
        {diff.truncated && <div className="ui-diff-note">Showing first {MAX_DIFF_ROWS.toLocaleString()} differences.</div>}
        {diff.rows.length === 0
          ? <div className="ui-diff-empty">No differences detected.</div>
          : <div className="ui-diff-table-wrapper">
            <table className="ui-diff-table">
              <thead><tr>
                <th>#</th>
                <th>Type</th>
                {diff.columns.map((column, index) => <th key={`${column.name}:${index}`}>{column.name}</th>)}
              </tr></thead>
              <tbody>
                {diff.rows.map(row => <tr key={row.rowIndex} className={`ui-diff-row-${row.type}`}>
                  <td>{(row.rowIndex + 1).toLocaleString()}</td>
                  <td>{row.type.toUpperCase()}</td>
                  {row.cells.map((cell, index) => <td
                    key={index}
                    className={row.type === 'added' ? 'ui-diff-cell-added' : row.type === 'removed' ? 'ui-diff-cell-removed' : cell.changed ? 'ui-diff-cell-changed' : undefined}
                  >
                    {row.type === 'added'
                      ? cell.after
                      : row.type === 'removed'
                        ? cell.before
                        : cell.changed
                          ? <><div className="ui-diff-cell-before">{cell.before}</div><div className="ui-diff-cell-after">{cell.after}</div></>
                          : cell.after}
                  </td>)}
                </tr>)}
              </tbody>
            </table>
          </div>}
      </>}
  </section>;
}
