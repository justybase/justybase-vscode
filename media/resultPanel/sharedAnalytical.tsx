import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { applyAnomalies } from './analytical/anomalyRules.js';
import { computeGroupStatsSync } from './analytical/computeGroupStats.js';
import type { AnalyticalColumnStats, AnalyticalDataset, AnalyticalGroup } from './analytical/types.js';
import { classifyColumns } from './explore/columnClassification.js';

export interface SharedAnalyticalColumn {
  readonly name: string;
  readonly type?: string;
}

export interface SharedAnalyticalViewProps {
  readonly columns: readonly SharedAnalyticalColumn[];
  readonly rows: readonly (readonly unknown[])[];
  /** Existing grid grouping; its first column becomes the initial group. */
  readonly grouping?: readonly string[];
  readonly onClose: () => void;
}

/** The in-browser engine is synchronous; keep one click from freezing a huge result. */
const ANALYTICAL_MAX_SHARED_ROWS = 50_000;
const ANALYTICAL_MAX_GROUPS = 500;

function formatStatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function columnSummary(stats: AnalyticalColumnStats): string {
  if (stats.numeric) {
    return `${formatStatNumber(stats.numeric.min)} … ${formatStatNumber(stats.numeric.max)} · avg ${formatStatNumber(stats.numeric.mean)}`;
  }
  if (stats.date) return `${stats.date.min} … ${stats.date.max}`;
  return stats.topValues.slice(0, 3).map(value => `${value.value} (${value.count.toLocaleString('en-US')})`).join(', ');
}

function flagLabel(group: AnalyticalGroup): string {
  if (group.flags.length === 0) return '';
  return group.flags.slice(0, 2).map(flag => flag.rule.replace(/_/gu, ' ').toLowerCase()).join(', ');
}

/**
 * Compact shared implementation of the legacy Analytical layout: groups the
 * loaded rows by one column, scores each group against the whole result and
 * shows per-column statistics for the selected group.
 */
export function SharedAnalyticalView({ columns, rows, grouping, onClose }: SharedAnalyticalViewProps): ReactNode {
  const dimensions = useMemo(() => {
    const roles = classifyColumns(columns.map(column => ({ name: column.name, type: column.type })), rows);
    const candidates = columns
      .map((column, index) => ({ column, index, role: roles[index] ?? 'unknown' }))
      .filter(item => item.role !== 'measure');
    return candidates.length > 0 ? candidates : columns.map((column, index) => ({ column, index, role: 'unknown' as const }));
  }, [columns, rows]);
  const initialGrouping = (grouping ?? [])
    .filter(name => columns.some(column => column.name === name))
    .slice(0, 3);
  const [groupColumns, setGroupColumns] = useState<readonly (string | undefined)[]>(() => {
    const initial = initialGrouping.length > 0 ? initialGrouping : dimensions[0]?.column.name ? [dimensions[0].column.name] : [];
    return [initial[0], initial[1], initial[2]];
  });
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | undefined>();
  const selectedGroupColumns = groupColumns.filter((name): name is string => !!name);
  const selectedGroupColumnsKey = selectedGroupColumns.join('\u0000');

  const selectGroupColumn = (slot: number, name: string): void => {
    const next: Array<string | undefined> = [...groupColumns];
    if (name) {
      for (let index = 0; index < next.length; index += 1) {
        if (index !== slot && next[index] === name) next[index] = undefined;
      }
    }
    next[slot] = name || undefined;
    if (!next[0]) next[0] = dimensions[0]?.column.name ?? columns[0]?.name;
    while (next.length > 1 && next[next.length - 1] === undefined) next.pop();
    setGroupColumns(next);
    setSelectedGroupKey(undefined);
  };

  const analysis = useMemo((): { dataset?: AnalyticalDataset; error?: string } => {
    const resolved = selectedGroupColumns
      .map(name => ({ name, index: columns.findIndex(column => column.name === name) }))
      .filter(item => item.index >= 0);
    if (resolved.length === 0) return { error: 'Choose a column to group by.' };
    if (rows.length === 0) return { error: 'The result has no loaded rows to analyze.' };
    if (rows.length > ANALYTICAL_MAX_SHARED_ROWS) {
      return { error: `Analytical view supports up to ${ANALYTICAL_MAX_SHARED_ROWS.toLocaleString('en-US')} loaded rows; this result has ${rows.length.toLocaleString('en-US')}.` };
    }
    try {
      const roles = classifyColumns(columns.map(column => ({ name: column.name, type: column.type })), rows);
      const dataset = computeGroupStatsSync({
        columns: columns.map((column, index) => ({ index, name: column.name, role: roles[index] ?? 'unknown' })),
        rows,
        groupColumns: resolved,
        maxGroups: ANALYTICAL_MAX_GROUPS,
      });
      return {
        dataset: applyAnomalies(dataset, {
          sensitivity: 'normal',
          minGroupRows: 2,
        }),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [columns, rows, selectedGroupColumnsKey]);

  const dataset = analysis.dataset;
  const selected = dataset?.groups.find(group => group.key === selectedGroupKey) ?? dataset?.groups[0];

  return <section className="ui-analytical-view" aria-label="Analytical view">
    <header className="ui-analytical-header">
      <div className="ui-analytical-title">
        <h2>Analytical view</h2>
        <span>Groups compared with the whole result</span>
      </div>
      <div className="ui-analytical-controls">
        <div className="ui-analytical-group-picks">
          <span>Group by</span>
          {[0, 1, 2].map(slot => <select
            key={slot}
            aria-label={slot === 0 ? 'Analytical group column' : `Analytical group column ${slot + 1}`}
            value={groupColumns[slot] ?? ''}
            onChange={event => selectGroupColumn(slot, event.target.value)}
          >
            {slot > 0 && <option value="">—</option>}
            {columns.map((column, index) => <option key={`${column.name}:${index}`} value={column.name}>{column.name}</option>)}
          </select>)}
        </div>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </header>
    {analysis.error
      ? <div className="ui-analytical-empty" role="status">{analysis.error}</div>
      : dataset && <>
        <div className="ui-analytical-status">
          {dataset.groups.length.toLocaleString('en-US')} groups · {dataset.totalRows.toLocaleString('en-US')} rows · {dataset.population.length.toLocaleString('en-US')} columns compared
          {dataset.groupsTruncated && ` · showing the first ${dataset.groups.length.toLocaleString('en-US')} of ${dataset.totalGroups.toLocaleString('en-US')}`}
        </div>
        <div className="ui-analytical-body">
          <div className="ui-analytical-groups">
            <table>
              <thead><tr><th>Group</th><th>Rows</th><th>Share</th><th>Score</th><th>Flags</th></tr></thead>
              <tbody>
                {dataset.groups.map(group => <tr
                  key={group.key}
                  className={`${selected?.key === group.key ? 'selected' : ''}${group.anomalous ? ' anomalous' : ''}`}
                  onClick={() => setSelectedGroupKey(group.key)}
                >
                  <td title={group.label}>{group.label}</td>
                  <td>{group.rowCount.toLocaleString('en-US')}</td>
                  <td>{(group.share * 100).toFixed(1)}%</td>
                  <td>{group.score.toFixed(2)}</td>
                  <td className="ui-analytical-flags">{flagLabel(group)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className="ui-analytical-detail">
            {selected
              ? <>
                <div className="ui-analytical-detail-title">
                  <strong>{selected.label}</strong>
                  <span>{selected.rowCount.toLocaleString('en-US')} rows · {(selected.share * 100).toFixed(1)}% of the result</span>
                </div>
                {selected.flags.length > 0 && <ul className="ui-analytical-flag-list">
                  {selected.flags.map((flag, index) => <li key={`${flag.rule}:${flag.columnIndex ?? 'group'}:${index}`}>{flag.message}</li>)}
                </ul>}
                <table>
                  <thead><tr><th>Column</th><th>Nulls</th><th>Distinct</th><th>Summary</th></tr></thead>
                  <tbody>
                    {selected.columns.map(stats => <tr key={`${stats.columnIndex}:${stats.name}`}>
                      <td>{stats.name}</td>
                      <td>{stats.nullCount > 0 ? `${stats.nullCount.toLocaleString('en-US')} (${(stats.nullRate * 100).toFixed(1)}%)` : ''}</td>
                      <td>{stats.distinctApprox ? '~' : ''}{stats.distinctCount.toLocaleString('en-US')}</td>
                      <td title={columnSummary(stats)}>{columnSummary(stats)}</td>
                    </tr>)}
                  </tbody>
                </table>
              </>
              : <div className="ui-analytical-empty">No groups to show.</div>}
          </div>
        </div>
      </>}
  </section>;
}
