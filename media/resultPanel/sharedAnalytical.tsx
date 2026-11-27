import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ANOMALY_RULES, applyAnomalies } from './analytical/anomalyRules.js';
import { computeGroupStatsSync } from './analytical/computeGroupStats.js';
import {
  DETECTION_CHOICES,
  DETECTION_CHOICE_HELP,
  DETECTION_CHOICE_LABELS,
  DETECTION_MODE_NAME,
  resolveDetection,
  type ResolvedDetection,
} from './analytical/detectionConfig.js';
import {
  ANALYTICAL_DEFAULT_MIN_GROUP_ROWS,
  ANALYTICAL_MAX_ANALYZED_COLUMNS,
  ANALYTICAL_MAX_GROUPS,
  ANALYTICAL_SCORE_ANOMALOUS,
  type AnalyticalColumnStats,
  type AnalyticalDataset,
  type AnalyticalGroup,
  type AnalyticalSensitivity,
  type AnomalyRuleId,
  type DetectionChoice,
  type SkippedEvaluationReason,
} from './analytical/types.js';
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
const SENSITIVITY_OPTIONS: readonly AnalyticalSensitivity[] = ['low', 'normal', 'high'];
const SENSITIVITY_LABELS: Record<AnalyticalSensitivity, string> = {
  low: 'Low — fewer alerts',
  normal: 'Normal',
  high: 'High — more alerts',
};
const SORT_LABELS = {
  size: 'Largest first',
  score: 'Highest score first',
  name: 'Name A–Z',
} as const;
type AnalyticalSortKey = keyof typeof SORT_LABELS;
const SKIPPED_REASON: Record<SkippedEvaluationReason, string> = {
  'too-many-distinct': 'too many distinct values',
  'too-many-groups': 'too many groups',
  'not-numeric': 'values are stored as text',
  approximate: 'counts are approximate',
};
const RULE_TITLES = new Map(ANOMALY_RULES.map(rule => [rule.id, rule.title] as const));

function formatStatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatEvidence(value: number | string | null): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function columnSummary(stats: AnalyticalColumnStats): string {
  if (stats.numeric) {
    return `${formatStatNumber(stats.numeric.min)} … ${formatStatNumber(stats.numeric.max)} · avg ${formatStatNumber(stats.numeric.mean)}`;
  }
  if (stats.date) return `${stats.date.min} … ${stats.date.max}`;
  const nonNull = stats.rowCount - stats.nullCount;
  return stats.topValues.slice(0, 3).map(value => {
    const share = nonNull > 0 ? `, ${((value.count / nonNull) * 100).toFixed(1)}%` : '';
    return `${value.value} (${formatStatNumber(value.count)}${share})`;
  }).join(', ');
}

function flagLabel(group: AnalyticalGroup): string {
  if (group.flags.length === 0) return '';
  const labels = group.flags.slice(0, 3).map(flag => RULE_TITLES.get(flag.rule) ?? flag.rule);
  return labels.join(', ') + (group.flags.length > 3 ? ` +${group.flags.length - 3}` : '');
}

function selectedGroupNotice(dataset: AnalyticalDataset, resolved: ResolvedDetection): string[] {
  const notices: string[] = [];
  if (resolved.notice) notices.push(resolved.notice);
  if (dataset.groupsTruncated) {
    notices.push(`Showing the ${dataset.groups.length.toLocaleString('en-US')} largest of ${dataset.totalGroups.toLocaleString('en-US')} groups; ${dataset.unlistedRows.toLocaleString('en-US')} rows are outside the listed groups.`);
  }
  if (dataset.analyzedColumnsTruncated) {
    notices.push(`Only the first ${ANALYTICAL_MAX_ANALYZED_COLUMNS} columns are analyzed.`);
  }
  for (const skipped of dataset.coverage?.skipped ?? []) {
    const columnName = dataset.population.find(column => column.columnIndex === skipped.columnIndex)?.name
      ?? `Column ${skipped.columnIndex + 1}`;
    const rules = skipped.rules.map(rule => RULE_TITLES.get(rule) ?? rule).join(', ');
    notices.push(`${columnName}: skipped ${rules} (${SKIPPED_REASON[skipped.reason]}).`);
  }
  return notices;
}

/**
 * In-memory Analytical view: groups the loaded rows, scores them against the
 * selected baseline and explains every flag. Options re-score the cached
 * statistics; only the grouping and robust quartiles recompute the dataset.
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
  const [detection, setDetection] = useState<DetectionChoice>('default');
  const [sensitivity, setSensitivity] = useState<AnalyticalSensitivity>('normal');
  const [minGroupRows, setMinGroupRows] = useState(ANALYTICAL_DEFAULT_MIN_GROUP_ROWS);
  const [disabledRules, setDisabledRules] = useState<readonly AnomalyRuleId[]>([]);
  const [excludedColumns, setExcludedColumns] = useState<readonly number[]>([]);
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [sortKey, setSortKey] = useState<AnalyticalSortKey>('size');
  const [sortDesc, setSortDesc] = useState(true);
  const [referenceGroupKey, setReferenceGroupKey] = useState<string | undefined>();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | undefined>();

  const selectedGroupColumns = groupColumns.filter((name): name is string => !!name);
  const selectedGroupColumnsKey = selectedGroupColumns.join('\u0000');
  const needsQuantiles = detection === 'robust';

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
    setReferenceGroupKey(undefined);
  };

  const base = useMemo((): { dataset?: AnalyticalDataset; error?: string } => {
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
      return {
        dataset: computeGroupStatsSync({
          columns: columns.map((column, index) => ({ index, name: column.name, role: roles[index] ?? 'unknown' })),
          rows,
          groupColumns: resolved,
          maxGroups: ANALYTICAL_MAX_GROUPS,
          quantiles: needsQuantiles,
        }),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [columns, needsQuantiles, rows, selectedGroupColumnsKey]);

  const scored = useMemo((): { dataset?: AnalyticalDataset; resolved?: ResolvedDetection; error?: string } => {
    if (!base.dataset) return { error: base.error };
    const dataset = base.dataset;
    const referenceKey = detection === 'reference' && referenceGroupKey && dataset.groups.some(group => group.key === referenceGroupKey)
      ? referenceGroupKey
      : undefined;
    const resolved = resolveDetection(detection, {
      listedGroups: dataset.groups.length,
      qualifyingGroups: dataset.groups.filter(group => group.rowCount >= minGroupRows).length,
      quantilesAvailable: dataset.coverage?.quantiles === true,
      referenceKey,
    });
    return {
      resolved,
      dataset: applyAnomalies(dataset, {
        sensitivity,
        minGroupRows,
        mode: resolved.effective,
        referenceGroupKey: resolved.effective === 'reference' ? referenceKey : undefined,
        disabledRules,
        excludedColumns,
      }),
    };
  }, [base, detection, disabledRules, excludedColumns, minGroupRows, referenceGroupKey, sensitivity]);

  const visibleGroups = useMemo(() => {
    if (!scored.dataset) return [];
    const direction = sortDesc ? -1 : 1;
    const groups = [...scored.dataset.groups].sort((left, right) => {
      if (sortKey === 'size') return (left.rowCount - right.rowCount) * direction;
      if (sortKey === 'score') return (left.score - right.score) * direction;
      return left.label.localeCompare(right.label) * direction;
    });
    return anomaliesOnly ? groups.filter(group => group.anomalous) : groups;
  }, [anomaliesOnly, scored.dataset, sortDesc, sortKey]);

  const selected = visibleGroups.find(group => group.key === selectedGroupKey) ?? visibleGroups[0];
  const notices = scored.dataset && scored.resolved ? selectedGroupNotice(scored.dataset, scored.resolved) : [];
  const referenceOptions = base.dataset?.groups ?? [];
  const activeReferenceKey = referenceOptions.some(group => group.key === referenceGroupKey) ? referenceGroupKey ?? '' : '';
  const anomalyCount = scored.dataset?.groups.filter(group => group.anomalous).length ?? 0;
  const flaggedColumns = new Set(selected?.flags.map(flag => flag.columnIndex).filter((index): index is number => index !== undefined) ?? []);
  const detailColumns = selected
    ? [...selected.columns].sort((left, right) => Number(flaggedColumns.has(right.columnIndex)) - Number(flaggedColumns.has(left.columnIndex)))
    : [];

  const changeSort = (key: AnalyticalSortKey): void => {
    setSortKey(key);
    // Name reads naturally A–Z; size and score start with the largest/highest.
    setSortDesc(key !== 'name');
  };
  const toggleRule = (rule: AnomalyRuleId, enabled: boolean): void => {
    setDisabledRules(current => enabled
      ? current.filter(id => id !== rule)
      : current.includes(rule) ? current : [...current, rule]);
  };
  const toggleExcludedColumn = (columnIndex: number, excluded: boolean): void => {
    setExcludedColumns(current => excluded
      ? current.filter(index => index !== columnIndex)
      : current.includes(columnIndex) ? current : [...current, columnIndex]);
  };
  const resetOptions = (): void => {
    setDetection('default');
    setSensitivity('normal');
    setMinGroupRows(ANALYTICAL_DEFAULT_MIN_GROUP_ROWS);
    setDisabledRules([]);
    setExcludedColumns([]);
    setAnomaliesOnly(false);
    setSortKey('size');
    setSortDesc(true);
    setReferenceGroupKey(undefined);
  };

  return <section className="ui-analytical-view" aria-label="Analytical view">
    <header className="ui-analytical-header">
      <div className="ui-analytical-title">
        <h2>Analytical view</h2>
        <span>Groups compared with {scored.resolved ? DETECTION_MODE_NAME[scored.resolved.effective] : 'the selected baseline'}</span>
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
        <button type="button" aria-pressed={optionsOpen} onClick={() => setOptionsOpen(value => !value)}>Options</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </header>

    {optionsOpen && <section className="ui-analytical-options" aria-label="Analytical options">
      <div className="ui-analytical-options-grid">
        <label>Detection
          <select value={detection} title={DETECTION_CHOICE_HELP[detection]} onChange={event => setDetection(event.target.value as DetectionChoice)}>
            {DETECTION_CHOICES.map(choice => <option key={choice} value={choice}>{DETECTION_CHOICE_LABELS[choice]}</option>)}
          </select>
        </label>
        {detection === 'reference' && <label>Reference group
          <select value={activeReferenceKey} onChange={event => setReferenceGroupKey(event.target.value || undefined)}>
            <option value="">Choose a group…</option>
            {referenceOptions.map(group => <option key={group.key} value={group.key}>{group.label} ({formatStatNumber(group.rowCount)})</option>)}
          </select>
        </label>}
        <label>Sensitivity
          <select value={sensitivity} onChange={event => setSensitivity(event.target.value as AnalyticalSensitivity)}>
            {SENSITIVITY_OPTIONS.map(option => <option key={option} value={option}>{SENSITIVITY_LABELS[option]}</option>)}
          </select>
        </label>
        <label>Min group rows
          <input type="number" min={1} max={100_000} value={minGroupRows}
            onChange={event => setMinGroupRows(Math.max(1, Math.min(100_000, Math.trunc(Number(event.target.value)) || 1)))} />
        </label>
        <label>Sort
          <select value={sortKey} onChange={event => changeSort(event.target.value as AnalyticalSortKey)}>
            {Object.entries(SORT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label>Direction
          <select value={sortDesc ? 'desc' : 'asc'} onChange={event => setSortDesc(event.target.value === 'desc')}>
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </label>
        <label className="ui-analytical-check">
          <input type="checkbox" checked={anomaliesOnly} onChange={event => setAnomaliesOnly(event.target.checked)} />
          Anomalies only
        </label>
        <button type="button" onClick={resetOptions}>Reset</button>
      </div>
      <details className="ui-analytical-rule-picker">
        <summary>Rules ({ANOMALY_RULES.length - disabledRules.length}/{ANOMALY_RULES.length} enabled)</summary>
        <div className="ui-analytical-rule-grid">
          {ANOMALY_RULES.map(rule => <label key={rule.id} title={rule.description}>
            <input type="checkbox" checked={!disabledRules.includes(rule.id)} onChange={event => toggleRule(rule.id, event.target.checked)} />
            {rule.title}
          </label>)}
        </div>
      </details>
      <details className="ui-analytical-column-picker">
        <summary>Excluded columns ({excludedColumns.length})</summary>
        <div className="ui-analytical-rule-grid">
          {(base.dataset?.population ?? []).map(stats => <label key={stats.columnIndex}>
            <input type="checkbox" checked={excludedColumns.includes(stats.columnIndex)} onChange={event => toggleExcludedColumn(stats.columnIndex, event.target.checked)} />
            {stats.name}
          </label>)}
        </div>
      </details>
    </section>}

    {scored.error
      ? <div className="ui-analytical-empty" role="status">{scored.error}</div>
      : scored.dataset && scored.resolved && <>
        <div className="ui-analytical-status">
          {visibleGroups.length.toLocaleString('en-US')} of {scored.dataset.groups.length.toLocaleString('en-US')} groups · {scored.dataset.totalRows.toLocaleString('en-US')} rows · {scored.dataset.population.length.toLocaleString('en-US')} columns compared · {DETECTION_MODE_NAME[scored.resolved.effective]} mode
          {scored.resolved.viaAuto ? ' (auto)' : ''}
          {' · loaded rows'}
          {anomalyCount > 0 ? ` · ${anomalyCount.toLocaleString('en-US')} anomalous` : ''}
        </div>
        {notices.length > 0 && <div className="ui-analytical-notices" role="status">
          {notices.map((notice, index) => <p key={`${index}:${notice}`}>{notice}</p>)}
        </div>}
        <div className="ui-analytical-body">
          <div className="ui-analytical-groups">
            {visibleGroups.length === 0
              ? <div className="ui-analytical-empty">No groups match the current filter.</div>
              : <table>
                <thead><tr><th>Group</th><th>Rows</th><th>Share</th><th>Score</th><th>Flags</th></tr></thead>
                <tbody>
                  {visibleGroups.map(group => <tr
                    key={group.key}
                    tabIndex={0}
                    className={`${selected?.key === group.key ? 'selected' : ''}${group.anomalous ? ' anomalous' : ''}`}
                    title={group.flags.length > 0 ? group.flags.map(flag => flag.message).join('\n') : group.label}
                    onClick={() => setSelectedGroupKey(group.key)}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedGroupKey(group.key); } }}
                  >
                    <td title={group.label}>{group.label}{group.isReference ? ' (reference)' : ''}</td>
                    <td>{group.rowCount.toLocaleString('en-US')}</td>
                    <td>{(group.share * 100).toFixed(1)}%</td>
                    <td title={`Anomaly score; ${ANALYTICAL_SCORE_ANOMALOUS} or more is marked anomalous.`}>{group.score.toFixed(2)}</td>
                    <td className="ui-analytical-flags">{flagLabel(group)}</td>
                  </tr>)}
                </tbody>
              </table>}
          </div>
          <div className="ui-analytical-detail">
            {selected
              ? <>
                <div className="ui-analytical-detail-title">
                  <strong>{selected.label}{selected.isReference ? ' (reference)' : ''}</strong>
                  <span>{selected.rowCount.toLocaleString('en-US')} rows · {(selected.share * 100).toFixed(1)}% of the result{selected.isReference ? ' · not scored' : ''}</span>
                </div>
                {selected.flags.length > 0 && <ul className="ui-analytical-flag-list">
                  {selected.flags.map((flag, index) => <li key={`${flag.rule}:${flag.columnIndex ?? 'group'}:${index}`}>
                    <details className="ui-analytical-flag">
                      <summary>
                        <span className="ui-analytical-flag-rule">{RULE_TITLES.get(flag.rule) ?? flag.rule}</span>
                        <span>{flag.message}</span>
                      </summary>
                      <table className="ui-analytical-evidence">
                        <tbody>
                          <tr><th>Method</th><td>{flag.evidence.method}</td></tr>
                          <tr><th>Baseline</th><td>{DETECTION_MODE_NAME[flag.evidence.baseline]}</td></tr>
                          <tr><th>{flag.evidence.observedLabel}</th><td>{formatEvidence(flag.evidence.observed)}</td></tr>
                          <tr><th>{flag.evidence.expectedLabel}</th><td>{formatEvidence(flag.evidence.expected)}</td></tr>
                          {flag.evidence.threshold !== null && <tr><th>{flag.evidence.thresholdLabel}</th><td>{formatEvidence(flag.evidence.threshold)}</td></tr>}
                          {flag.evidence.effect !== null && <tr><th>Effect</th><td>{formatEvidence(flag.evidence.effect)}{flag.evidence.effectUnit ? ` ${flag.evidence.effectUnit}` : ''}</td></tr>}
                          <tr><th>Sample</th><td>{formatEvidence(flag.evidence.sampleSize)}{flag.evidence.baselineSize === undefined ? '' : ` · baseline ${formatEvidence(flag.evidence.baselineSize)}`}</td></tr>
                        </tbody>
                      </table>
                      {flag.evidence.notes && flag.evidence.notes.length > 0 && <ul className="ui-analytical-evidence-notes">
                        {flag.evidence.notes.map(note => <li key={note}>{note}</li>)}
                      </ul>}
                    </details>
                  </li>)}
                </ul>}
                <table>
                  <thead><tr><th>Column</th><th>Nulls</th><th>Distinct</th><th>Summary</th></tr></thead>
                  <tbody>
                    {detailColumns.map(stats => <tr key={`${stats.columnIndex}:${stats.name}`} className={flaggedColumns.has(stats.columnIndex) ? 'ui-analytical-column-flagged' : undefined}>
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
