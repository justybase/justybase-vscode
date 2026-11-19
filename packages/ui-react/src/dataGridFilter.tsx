import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { QueryColumnFilterOperator } from '@justybase/contracts';
import type { UiResultAggregationFunction, UiResultColumnAggregation } from '@justybase/ui-core';
import { AGGREGATION_FUNCTION_LABELS, AGGREGATION_LABELS } from './dataGridAggregation';

export interface DataGridFilterValueOption {
  readonly key: string;
  readonly value: unknown;
  readonly label: string;
}

export interface DataGridFilterConditionState {
  readonly operator: QueryColumnFilterOperator;
  readonly value: string;
  readonly value2?: string;
}

export interface DataGridColumnFilterState {
  readonly columnIndex: number;
  readonly columnName: string;
  readonly left: number;
  readonly top: number;
  /** Viewport-aware cap so the footer actions never fall off-screen. */
  readonly maxHeight?: number;
  readonly options: readonly DataGridFilterValueOption[];
  readonly selectedKeys: readonly string[];
  readonly operator: QueryColumnFilterOperator;
  readonly value: string;
  /** Upper bound for the `between` operator. */
  readonly value2?: string;
  /** Additional Excel-style conditions; the first entry mirrors operator/value/value2. */
  readonly conditions?: readonly DataGridFilterConditionState[];
  readonly conditionLogic?: 'and' | 'or';
  readonly search: string;
  readonly loading: boolean;
  readonly truncated: boolean;
  /** True after the user changes a filter control; opening and applying is a no-op. */
  readonly dirty?: boolean;
  readonly error?: string;
}

export interface DataGridColumnFilterPanelProps {
  readonly state: DataGridColumnFilterState;
  readonly onChange: (patch: Partial<DataGridColumnFilterState>) => void;
  readonly onApply: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
  /** Footer summaries configured for this column. */
  readonly summary?: readonly UiResultColumnAggregation[];
  readonly onSummaryChange?: (aggregations: readonly UiResultColumnAggregation[]) => void;
}

const FILTER_OPERATORS: readonly { readonly value: QueryColumnFilterOperator; readonly label: string }[] = [
  { value: 'in', label: 'Values' },
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Does not contain' },
  { value: 'equals', label: 'Equals' },
  { value: 'notEquals', label: 'Does not equal' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'endsWith', label: 'Ends with' },
  { value: 'like', label: 'Like (SQL % _)' },
  { value: 'greaterThan', label: 'Greater than' },
  { value: 'greaterThanOrEqual', label: 'Greater than or equal' },
  { value: 'lessThan', label: 'Less than' },
  { value: 'lessThanOrEqual', label: 'Less than or equal' },
  { value: 'between', label: 'Between' },
  { value: 'isNull', label: 'Is blank' },
  { value: 'isNotNull', label: 'Is not blank' },
  { value: 'isEmpty', label: 'Is empty' },
  { value: 'isNotEmpty', label: 'Is not empty' },
];

const SUMMARY_FUNCTIONS: readonly UiResultAggregationFunction[] = ['sum', 'avg', 'count', 'countDistinct', 'min', 'max'];

/**
 * Host-neutral Excel-style filter UI. Loading distinct values and translating
 * the selected state into a query remain adapter responsibilities; this
 * component only renders the stable interaction surface shared by hosts.
 *
 * The column menu mirrors the web workspace: a `Filter` / `Summary` toggle
 * instead of a second, separate aggregation popover.
 */
export function DataGridColumnFilterPanel({ state, onChange, onApply, onClear, onClose, summary = [], onSummaryChange }: DataGridColumnFilterPanelProps): ReactElement {
  const [mode, setMode] = useState<'filter' | 'summary'>('filter');
  const visibleOptions = useMemo(() => {
    const search = state.search.toLocaleLowerCase();
    return state.options.filter(option => option.label.toLocaleLowerCase().includes(search));
  }, [state.options, state.search]);
  const selected = new Set(state.selectedKeys);
  const conditions = state.conditions ?? [{
    operator: state.operator,
    value: state.value,
    ...(state.value2 === undefined ? {} : { value2: state.value2 }),
  }];
  const conditionLogic = state.conditionLogic ?? 'and';
  const activeFns = new Set(summary.map(item => item.fn));
  const summaryPosition = summary[0]?.position ?? 'bottom';

  const updateCondition = (index: number, patch: Partial<DataGridFilterConditionState>): void => {
    const next = conditions.map((condition, conditionIndex) => conditionIndex === index ? { ...condition, ...patch } : condition);
    const first = next[0]!;
    onChange({
      conditions: next,
      ...(index === 0 ? { operator: first.operator, value: first.value, value2: first.value2 ?? '' } : {}),
      dirty: true,
    });
  };
  const addCondition = (): void => {
    onChange({ conditions: [...conditions, { operator: 'equals', value: '' }], dirty: true });
  };
  const removeCondition = (index: number): void => {
    const next = conditions.filter((_condition, conditionIndex) => conditionIndex !== index);
    const first = next[0]!;
    onChange({
      conditions: next,
      operator: first.operator,
      value: first.value,
      value2: first.value2 ?? '',
      dirty: true,
    });
  };

  const selectVisible = (mode: 'all' | 'none' | 'invert'): void => {
    const visibleKeys = new Set(visibleOptions.map(option => option.key));
    const next = state.selectedKeys.filter(key => !visibleKeys.has(key));
    if (mode === 'all') next.push(...visibleOptions.map(option => option.key));
    if (mode === 'invert') next.push(...visibleOptions.filter(option => !selected.has(option.key)).map(option => option.key));
    onChange({ selectedKeys: [...new Set(next)], dirty: true });
  };

  const toggleSummaryFn = (fn: UiResultAggregationFunction, checked: boolean): void => {
    if (checked) {
      if (activeFns.has(fn)) return;
      onSummaryChange?.([...summary, { fn, position: summaryPosition }]);
      return;
    }
    if (!activeFns.has(fn)) return;
    onSummaryChange?.(summary.filter(item => item.fn !== fn));
  };

  const changeSummaryPosition = (position: 'top' | 'bottom'): void => {
    if (summary.length === 0) return;
    onSummaryChange?.(summary.map(item => ({ fn: item.fn, position })));
  };

  return <div className="ui-data-grid-filter-menu grid-column-filter-menu" role="dialog" aria-label={`Filter ${state.columnName}`} style={{ left: state.left, top: state.top, maxHeight: state.maxHeight }} onMouseDown={event => event.stopPropagation()}>
    <div className="ui-data-grid-filter-heading">
      <div className="ui-data-grid-filter-title"><span>FILTER COLUMN</span><strong>{state.columnName}</strong></div>
      <button type="button" className="ui-data-grid-filter-close" aria-label="Close filter" onClick={onClose}>×</button>
    </div>
    <div className="ui-data-grid-filter-tabs" role="tablist" aria-label={`Column ${state.columnName} options`}>
      <button type="button" role="tab" aria-selected={mode === 'filter'} className={mode === 'filter' ? 'active' : undefined} onClick={() => setMode('filter')}>Filter</button>
      <button type="button" role="tab" aria-selected={mode === 'summary'} className={mode === 'summary' ? 'active' : undefined} onClick={() => setMode('summary')}>Summary</button>
    </div>
    {mode === 'filter' ? <>
      <div className="ui-data-grid-filter-body">
        {state.operator === 'in'
          ? <label className="ui-data-grid-filter-condition"><span>Filter by</span><select aria-label={`Filter condition for ${state.columnName}`} value={state.operator} onChange={event => onChange({ operator: event.target.value as QueryColumnFilterOperator, dirty: true })}>{FILTER_OPERATORS.map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select></label>
          : <div className="ui-data-grid-filter-condition-heading"><span>Show rows where</span>{conditions.length > 1 && <label className="ui-data-grid-filter-logic">Match <select aria-label={`Condition logic for ${state.columnName}`} value={conditionLogic} onChange={event => onChange({ conditionLogic: event.target.value === 'or' ? 'or' : 'and', dirty: true })}><option value="and">all</option><option value="or">any</option></select></label>}</div>}
        {state.operator === 'in' ? <>
          <input className="ui-data-grid-filter-search" aria-label={`Search values for ${state.columnName}`} placeholder="Search values…" value={state.search} onChange={event => onChange({ search: event.target.value })} />
          <div className="ui-data-grid-filter-selection-actions"><button type="button" onClick={() => selectVisible('all')}>Select all</button><button type="button" onClick={() => selectVisible('none')}>Deselect all</button><button type="button" onClick={() => selectVisible('invert')}>Invert</button></div>
          <div className="ui-data-grid-filter-values" role="group" aria-label={`Values for ${state.columnName}`}>
            {visibleOptions.map(option => <label key={option.key}><input type="checkbox" checked={selected.has(option.key)} onChange={event => onChange({ selectedKeys: event.target.checked ? [...new Set([...state.selectedKeys, option.key])] : state.selectedKeys.filter(key => key !== option.key), dirty: true })} /><span title={option.label}>{option.label}</span></label>)}
            {!state.loading && state.options.length === 0 && <span className="ui-data-grid-filter-empty">No values available.</span>}
          </div>
          <small className="ui-data-grid-filter-summary">{state.selectedKeys.length.toLocaleString()} selected{state.truncated ? ' · list truncated' : ''}</small>
        </> : <>
          {conditions.map((condition, index) => {
            const isValueOperator = !['isNull', 'isNotNull', 'isEmpty', 'isNotEmpty'].includes(condition.operator);
            return <div className="ui-data-grid-filter-condition-row" key={index}>
              <select aria-label={index === 0 ? `Filter condition for ${state.columnName}` : `Condition ${index + 1} for ${state.columnName}`} value={condition.operator} onChange={event => updateCondition(index, { operator: event.target.value as QueryColumnFilterOperator })}>{FILTER_OPERATORS.filter(operator => operator.value !== 'in').map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select>
              {condition.operator === 'between'
                ? <div className="ui-data-grid-filter-between">
                  <input className="ui-data-grid-filter-value" aria-label={index === 0 ? `Lower bound for ${state.columnName}` : `Lower bound ${index + 1} for ${state.columnName}`} placeholder="From" value={condition.value} onChange={event => updateCondition(index, { value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') onApply(); }} />
                  <input className="ui-data-grid-filter-value" aria-label={index === 0 ? `Upper bound for ${state.columnName}` : `Upper bound ${index + 1} for ${state.columnName}`} placeholder="To" value={condition.value2 ?? ''} onChange={event => updateCondition(index, { value2: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') onApply(); }} />
                </div>
                : isValueOperator
                  ? <input className="ui-data-grid-filter-value" aria-label={index === 0 ? `Filter value for ${state.columnName}` : `Value ${index + 1} for ${state.columnName}`} placeholder="Enter a value" value={condition.value} onChange={event => updateCondition(index, { value: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') onApply(); }} />
                  : <span className="ui-data-grid-filter-hint">{condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty' ? 'Empty text values' : 'NULL values'}</span>}
              {conditions.length > 1 && <button type="button" className="ui-data-grid-filter-remove" aria-label={`Remove condition ${index + 1}`} title="Remove condition" onClick={() => removeCondition(index)}>−</button>}
            </div>;
          })}
          <button type="button" className="ui-data-grid-filter-add" onClick={addCondition}>+ Add condition</button>
        </>}
        {(state.loading || state.error) && <span className={state.error ? 'ui-data-grid-filter-error' : 'ui-data-grid-filter-loading'} role={state.error ? 'alert' : 'status'}>{state.error ?? 'Loading distinct values…'}</span>}
      </div>
      <div className="ui-data-grid-filter-footer"><button type="button" className="ui-data-grid-filter-clear" onClick={onClear}>Clear filter</button><span className="ui-data-grid-filter-footer-spacer" /><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={state.loading} onClick={onApply}>Apply</button></div>
    </> : <div className="ui-data-grid-filter-summary-panel">
      <div className="ui-data-grid-summary-list" role="group" aria-label={`Summary functions for ${state.columnName}`}>
        {SUMMARY_FUNCTIONS.map(fn => <label key={fn}>
          <input type="checkbox" checked={activeFns.has(fn)} disabled={onSummaryChange === undefined} onChange={event => toggleSummaryFn(fn, event.target.checked)} />
          <span className="ui-data-grid-aggregation-symbol" aria-hidden="true">{AGGREGATION_LABELS[fn]}</span>
          <span>{AGGREGATION_FUNCTION_LABELS[fn]}</span>
        </label>)}
      </div>
      {summary.length > 0 && <fieldset className="ui-data-grid-filter-summary-position">
        <legend>Show summary</legend>
        <label><input type="radio" name={`summary-position-${state.columnIndex}`} checked={summaryPosition === 'bottom'} onChange={() => changeSummaryPosition('bottom')} /> Bottom</label>
        <label><input type="radio" name={`summary-position-${state.columnIndex}`} checked={summaryPosition === 'top'} onChange={() => changeSummaryPosition('top')} /> Top</label>
      </fieldset>}
      <div className="ui-data-grid-filter-footer"><span className="ui-data-grid-filter-footer-spacer" /><button type="button" onClick={onClose}>Done</button></div>
    </div>}
  </div>;
}
