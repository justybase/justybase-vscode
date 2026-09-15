import { useMemo } from 'react';
import type { ReactElement } from 'react';
import type { QueryColumnFilterOperator } from '@justybase/contracts';

export interface DataGridFilterValueOption {
  readonly key: string;
  readonly value: unknown;
  readonly label: string;
}

export interface DataGridColumnFilterState {
  readonly columnIndex: number;
  readonly columnName: string;
  readonly left: number;
  readonly top: number;
  readonly options: readonly DataGridFilterValueOption[];
  readonly selectedKeys: readonly string[];
  readonly operator: QueryColumnFilterOperator;
  readonly value: string;
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
}

const FILTER_OPERATORS: readonly { readonly value: QueryColumnFilterOperator; readonly label: string }[] = [
  { value: 'in', label: 'Values' },
  { value: 'contains', label: 'Contains' },
  { value: 'equals', label: 'Equals' },
  { value: 'notEquals', label: 'Does not equal' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'endsWith', label: 'Ends with' },
  { value: 'greaterThan', label: 'Greater than' },
  { value: 'greaterThanOrEqual', label: 'Greater than or equal' },
  { value: 'lessThan', label: 'Less than' },
  { value: 'lessThanOrEqual', label: 'Less than or equal' },
  { value: 'isNull', label: 'Is blank' },
  { value: 'isNotNull', label: 'Is not blank' },
];

/**
 * Host-neutral Excel-style filter UI. Loading distinct values and translating
 * the selected state into a query remain adapter responsibilities; this
 * component only renders the stable interaction surface shared by Web and
 * Electron.
 */
export function DataGridColumnFilterPanel({ state, onChange, onApply, onClear, onClose }: DataGridColumnFilterPanelProps): ReactElement {
  const visibleOptions = useMemo(() => {
    const search = state.search.toLocaleLowerCase();
    return state.options.filter(option => option.label.toLocaleLowerCase().includes(search));
  }, [state.options, state.search]);
  const selected = new Set(state.selectedKeys);
  const isValueOperator = state.operator !== 'isNull' && state.operator !== 'isNotNull';

  const selectVisible = (mode: 'all' | 'none' | 'invert'): void => {
    const visibleKeys = new Set(visibleOptions.map(option => option.key));
    const next = state.selectedKeys.filter(key => !visibleKeys.has(key));
    if (mode === 'all') next.push(...visibleOptions.map(option => option.key));
    if (mode === 'invert') next.push(...visibleOptions.filter(option => !selected.has(option.key)).map(option => option.key));
    onChange({ selectedKeys: [...new Set(next)], dirty: true });
  };

  return <div className="ui-data-grid-filter-menu grid-column-filter-menu" role="dialog" aria-label={`Filter ${state.columnName}`} style={{ left: state.left, top: state.top }} onMouseDown={event => event.stopPropagation()}>
    <div className="ui-data-grid-filter-heading">
      <div className="ui-data-grid-filter-title"><span>FILTER COLUMN</span><strong>{state.columnName}</strong></div>
      <button type="button" className="ui-data-grid-filter-close" aria-label="Close filter" onClick={onClose}>×</button>
    </div>
    <div className="ui-data-grid-filter-body">
      <label className="ui-data-grid-filter-condition"><span>Filter by</span><select aria-label={`Filter condition for ${state.columnName}`} value={state.operator} onChange={event => onChange({ operator: event.target.value as QueryColumnFilterOperator, dirty: true })}>{FILTER_OPERATORS.map(operator => <option key={operator.value} value={operator.value}>{operator.label}</option>)}</select></label>
      {state.operator === 'in' ? <>
        <input className="ui-data-grid-filter-search" aria-label={`Search values for ${state.columnName}`} placeholder="Search values…" value={state.search} onChange={event => onChange({ search: event.target.value })} />
        <div className="ui-data-grid-filter-selection-actions"><button type="button" onClick={() => selectVisible('all')}>Select all</button><button type="button" onClick={() => selectVisible('none')}>Deselect all</button><button type="button" onClick={() => selectVisible('invert')}>Invert</button></div>
        <div className="ui-data-grid-filter-values" role="group" aria-label={`Values for ${state.columnName}`}>
          {visibleOptions.map(option => <label key={option.key}><input type="checkbox" checked={selected.has(option.key)} onChange={event => onChange({ selectedKeys: event.target.checked ? [...new Set([...state.selectedKeys, option.key])] : state.selectedKeys.filter(key => key !== option.key), dirty: true })} /><span title={option.label}>{option.label}</span></label>)}
          {!state.loading && state.options.length === 0 && <span className="ui-data-grid-filter-empty">No values available.</span>}
        </div>
        <small className="ui-data-grid-filter-summary">{state.selectedKeys.length.toLocaleString()} selected{state.truncated ? ' · first 500 values' : ''}</small>
      </> : isValueOperator ? <input className="ui-data-grid-filter-value" aria-label={`Filter value for ${state.columnName}`} placeholder="Enter a value…" value={state.value} onChange={event => onChange({ value: event.target.value, dirty: true })} onKeyDown={event => { if (event.key === 'Enter') onApply(); }} /> : <p className="ui-data-grid-filter-hint">Rows are matched against NULL values.</p>}
      {state.loading && <span className="ui-data-grid-filter-loading" role="status">Loading distinct values…</span>}
      {state.error && <span className="ui-data-grid-filter-error" role="alert">{state.error}</span>}
    </div>
    <div className="ui-data-grid-filter-footer"><button type="button" className="ui-data-grid-filter-clear" onClick={onClear}>Clear filter</button><span className="ui-data-grid-filter-footer-spacer" /><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={state.loading} onClick={onApply}>Apply</button></div>
  </div>;
}
