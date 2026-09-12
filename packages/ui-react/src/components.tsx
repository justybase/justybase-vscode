import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { CapabilityDescriptor } from '@justybase/contracts';
import type { MetadataNode } from '@justybase/ui-core';
import type { UiResultSurfaceState } from '@justybase/ui-core';
import type { UiResultViewState } from '@justybase/ui-core';
import { uiTokens } from './tokens';
import { formatDataGridCellValue } from './dataGrid';
import type { DataGridColumn } from './dataGrid';
export { DataGrid, formatDataGridCellValue } from './dataGrid';
export type { DataGridCellContext, DataGridColumn, DataGridCopyPayload, DataGridProps, DataGridSelection, DataGridViewState, DataGridVirtualWindow, GridScrollPosition } from './dataGrid';

export type AsyncViewState = 'loading' | 'empty' | 'error' | 'cancelled' | 'ready';

export interface AsyncStateViewProps {
  readonly state: AsyncViewState;
  readonly message?: string;
  readonly loadingLabel?: string;
  readonly emptyLabel?: string;
  readonly cancelledLabel?: string;
  readonly children?: ReactNode;
}

export function AsyncStateView({ state, message, loadingLabel = 'Loading…', emptyLabel = 'Nothing to show.', cancelledLabel = 'Cancelled.', children }: AsyncStateViewProps): ReactNode {
  if (state === 'ready') return <>{children}</>;
  const label = state === 'loading' ? loadingLabel : state === 'empty' ? emptyLabel : state === 'cancelled' ? cancelledLabel : message ?? 'Something went wrong.';
  return <div className={`ui-async-state ui-async-${state}`} role={state === 'error' ? 'alert' : 'status'} aria-live="polite">{label}</div>;
}

export interface CapabilityGateProps {
  readonly capability?: CapabilityDescriptor;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
  readonly allowReadOnly?: boolean;
}

export function CapabilityGate({ capability, children, fallback, allowReadOnly = true }: CapabilityGateProps): ReactNode {
  const allowed = capability?.status === 'available' || (allowReadOnly && capability?.status === 'read-only');
  if (allowed) return <>{children}</>;
  return <>{fallback ?? <div className="ui-capability-state" role="status">{capability?.reason ?? `This capability is ${capability?.status ?? 'unavailable'}.`}</div>}</>;
}

export interface UiShellProps {
  readonly title: string;
  readonly activeSurface: string;
  readonly onSurfaceChange?: (surface: string) => void;
  readonly surfaces?: readonly { readonly id: string; readonly label: string }[];
  readonly sidebar?: ReactNode;
  readonly children: ReactNode;
}

export function UiShell({ title, activeSurface, onSurfaceChange, surfaces = [], sidebar, children }: UiShellProps): ReactNode {
  return <div className="ui-shell" data-active-surface={activeSurface} style={{ color: uiTokens.color.text, background: uiTokens.color.background }}>
    <header className="ui-shell-header"><h1>{title}</h1><nav aria-label="Workspace surfaces">{surfaces.map(surface => <button type="button" key={surface.id} aria-current={surface.id === activeSurface ? 'page' : undefined} onClick={() => onSurfaceChange?.(surface.id)}>{surface.label}</button>)}</nav></header>
    <div className="ui-shell-body">{sidebar && <aside className="ui-shell-sidebar" aria-label="Sidebar">{sidebar}</aside>}<main className="ui-shell-main">{children}</main></div>
  </div>;
}

export interface WorkspaceTab {
  readonly id: string;
  readonly label: string;
  readonly dirty?: boolean;
}

export interface WorkspaceTabsProps {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeId?: string;
  readonly onSelect: (id: string) => void;
  readonly onClose?: (id: string) => void;
}

export function WorkspaceTabs({ tabs, activeId, onSelect, onClose }: WorkspaceTabsProps): ReactNode {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    onSelect(next.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  }
  return <div className="ui-workspace-tabs" role="tablist" aria-label="Open documents">{tabs.map((tab, index) => <div className="ui-workspace-tab" key={tab.id}>
    <button type="button" role="tab" aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} onClick={() => onSelect(tab.id)} onKeyDown={event => move(event, index)}>{tab.label}{tab.dirty ? ' •' : ''}</button>
    {onClose && <button type="button" aria-label={`Close ${tab.label}`} onClick={() => onClose(tab.id)}>×</button>}
  </div>)}</div>;
}

export interface EditorSurfaceProps {
  readonly value: string;
  readonly label?: string;
  readonly readOnly?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: () => void;
}

export function EditorSurface({ value, label = 'SQL editor', readOnly = false, onChange, onSubmit }: EditorSurfaceProps): ReactNode {
  return <label className="ui-editor-surface">{label}<textarea aria-label={label} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); onSubmit?.(); } }} spellCheck={false} /></label>;
}

export function FocusOnMount({ children }: { readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div ref={ref} tabIndex={-1}>{children}</div>;
}

export function ResultTabs({ results, activeResultSetId, activeSourceId, onSelect }: ResultTabsProps): ReactNode {
  const matchingActiveResults = results.filter(result => result.resultSetId === activeResultSetId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusTab = (index: number): void => {
    const result = results[index];
    if (!result) return;
    onSelect(result.resultSetId, result.sourceId);
    tabRefs.current[index]?.focus();
  };
  return <div className="ui-result-tabs" role="tablist" aria-label="Result sets">{results.map((result, index) => {
    // A source-less active ID is only safe when it identifies one result. Do
    // not mark multiple same-named result sets active while the source is
    // being resolved.
    const active = result.resultSetId === activeResultSetId
      && (activeSourceId === undefined
        ? matchingActiveResults.length === 1
        : result.sourceId === activeSourceId);
    const tabIndex = active || (activeResultSetId === undefined && index === 0) ? 0 : -1;
    return <button type="button" role="tab" key={`${result.sourceId}:${result.resultSetId}`} ref={element => { tabRefs.current[index] = element; }} tabIndex={tabIndex} aria-selected={active} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + results.length) % results.length;
      focusTab(nextIndex);
    }} onClick={() => onSelect(result.resultSetId, result.sourceId)}>Result {index + 1}{result.status === 'streaming' ? ' · streaming' : ''}</button>;
  })}</div>;
}

export interface ResultViewToolbarProps {
  readonly columns: readonly { readonly name: string }[];
  readonly view: Pick<UiResultViewState, 'globalFilter' | 'sorting' | 'grouping' | 'aggregation' | 'pivotColumn'>;
  readonly onChange: (patch: Partial<UiResultViewState>) => void;
  readonly onRefresh?: () => void;
  readonly onCopy?: () => void;
  readonly onExport?: () => void;
}

/** Product-neutral controls for the common result view state. */
export function ResultViewToolbar({ columns, view, onChange, onRefresh, onCopy, onExport }: ResultViewToolbarProps): ReactNode {
  const firstColumn = columns[0]?.name;
  const canSelectColumn = firstColumn !== undefined;
  return <div className="ui-result-toolbar" role="toolbar" aria-label="Result view controls">
    <label>Filter<input aria-label="Filter results" value={view.globalFilter} onChange={event => onChange({ globalFilter: event.target.value })} /></label>
    <button type="button" aria-pressed={view.sorting.length > 0} disabled={!canSelectColumn && view.sorting.length === 0} onClick={() => onChange({ sorting: view.sorting.length > 0 ? [] : firstColumn === undefined ? [] : [{ column: firstColumn, descending: false }] })}>Sort</button>
    <button type="button" aria-pressed={view.grouping.length > 0} disabled={!canSelectColumn && view.grouping.length === 0} onClick={() => onChange({ grouping: view.grouping.length > 0 ? [] : firstColumn === undefined ? [] : [firstColumn] })}>Group</button>
    <button type="button" aria-pressed={view.aggregation !== undefined} onClick={() => onChange({ aggregation: view.aggregation === undefined ? 'count' : undefined })}>Aggregate</button>
    <button type="button" aria-pressed={view.pivotColumn !== undefined} disabled={!canSelectColumn && view.pivotColumn === undefined} onClick={() => onChange({ pivotColumn: view.pivotColumn === undefined ? firstColumn : undefined })}>Pivot</button>
    {onRefresh && <button type="button" onClick={onRefresh}>Refresh</button>}
    {onCopy && <button type="button" onClick={onCopy}>Copy</button>}
    {onExport && <button type="button" onClick={onExport}>Export</button>}
  </div>;
}

export interface RowDetailProps {
  readonly columns: readonly DataGridColumn[];
  readonly row: readonly unknown[];
  readonly onClose: () => void;
}

export function RowDetail({ columns, row, onClose }: RowDetailProps): ReactNode {
  return <aside className="ui-row-detail" aria-labelledby="ui-row-detail-title"><div><h2 id="ui-row-detail-title">Row details</h2><button type="button" onClick={onClose}>Close</button></div><dl>{columns.map((column, index) => <div key={`${column.name}:${index}`}><dt>{column.name}</dt><dd>{formatDataGridCellValue(row[index], column.type, column)}</dd></div>)}</dl></aside>;
}

export function SchemaTree({ nodes, selectedId, expandedIds, onToggle, onSelect }: SchemaTreeProps): ReactNode {
  const expanded = new Set(expandedIds ?? []);
  return <div className="ui-schema-tree" role="tree" aria-label="Schema">{nodes.map(node => <div className="ui-schema-node" role="treeitem" aria-selected={node.id === selectedId} aria-expanded={node.hasChildren ? expanded.has(node.id) : undefined} key={node.id}>
    {node.hasChildren && <button type="button" aria-label={`${expanded.has(node.id) ? 'Collapse' : 'Expand'} ${node.label}`} onClick={() => onToggle?.(node)}>{expanded.has(node.id) ? '▾' : '▸'}</button>}
    <button type="button" onClick={() => onSelect?.(node)}>{node.label}</button>
  </div>)}</div>;
}

export interface HistoryViewEntry {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly sqlFingerprint: string;
}

export interface ResultTabsProps {
  readonly results: readonly UiResultSurfaceState[];
  readonly activeResultSetId?: string;
  readonly activeSourceId?: string;
  readonly onSelect: (id: string, sourceId?: string) => void;
}

export interface SchemaTreeProps {
  readonly nodes: readonly MetadataNode[];
  readonly selectedId?: string;
  readonly expandedIds?: readonly string[];
  readonly onToggle?: (node: MetadataNode) => void;
  readonly onSelect?: (node: MetadataNode) => void;
}

export interface HistoryViewProps {
  readonly entries: readonly HistoryViewEntry[];
  readonly state?: AsyncViewState;
  readonly message?: string;
  readonly onOpen?: (entry: HistoryViewEntry) => void;
}

export interface ExplainViewProps {
  readonly state: AsyncViewState;
  readonly plan?: string;
  readonly message?: string;
  readonly onCancel?: () => void;
}

export interface DesignerFormProps {
  readonly fields: Readonly<Record<string, string>>;
  readonly capability?: CapabilityDescriptor;
  readonly onChange: (field: string, value: string) => void;
  readonly onPreview?: () => void;
  readonly onApply?: () => void;
}

export function HistoryView({ entries, state = 'ready', message, onOpen }: HistoryViewProps): ReactNode {
  return <section aria-labelledby="ui-history-title"><h2 id="ui-history-title">Query history</h2><AsyncStateView state={state} message={message} emptyLabel="No queries yet.">{entries.map(entry => <button type="button" className="ui-history-entry" key={entry.id} onClick={() => onOpen?.(entry)}><strong>{entry.status}</strong><span>{entry.label}</span><code>{entry.sqlFingerprint}</code></button>)}</AsyncStateView></section>;
}

export function ExplainView({ state, plan, message, onCancel }: ExplainViewProps): ReactNode {
  return <section className="ui-explain" aria-labelledby="ui-explain-title"><h2 id="ui-explain-title">Explain</h2><AsyncStateView state={state} message={message}>{plan && <pre>{plan}</pre>}</AsyncStateView>{state === 'loading' && onCancel && <button type="button" onClick={onCancel}>Cancel</button>}</section>;
}

export function DesignerForm({ fields, capability, onChange, onPreview, onApply }: DesignerFormProps): ReactNode {
  const canPreview = capability?.status === 'available' || capability?.status === 'read-only';
  const canApply = capability?.status === 'available';
  return <section className="ui-designer" aria-labelledby="ui-designer-title"><h2 id="ui-designer-title">Designer</h2><CapabilityGate capability={capability} fallback={<div className="ui-capability-state" role="status">{capability?.reason ?? 'Designer unavailable.'}</div>}><div className="ui-designer-fields">{Object.entries(fields).map(([field, value]) => <label key={field}>{field}<input value={value} onChange={event => onChange(field, event.target.value)} /></label>)}</div><div className="ui-designer-actions"><button type="button" disabled={!canPreview} onClick={onPreview}>Preview</button><button type="button" disabled={!canApply} onClick={onApply}>Apply</button></div></CapabilityGate></section>;
}
