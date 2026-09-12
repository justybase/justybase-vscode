import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { DATABASE_KIND_DISPLAY_NAMES, SUPPORTED_DATABASE_KINDS, type CapabilityDescriptor, type DatabaseKind } from '@justybase/contracts';
import type { MetadataNode } from '@justybase/ui-core';
import type { UiResultSurfaceState } from '@justybase/ui-core';
import type { UiResultViewState } from '@justybase/ui-core';
import { uiTokens } from './tokens';
import { formatDataGridCellValue } from './dataGrid';
import type { DataGridColumn } from './dataGrid';
export { DataGrid, formatDataGridCellValue, ResultGrid } from './dataGrid';
export type { DataGridCellContext, DataGridColumn, DataGridCopyPayload, DataGridProps, DataGridSelection, DataGridViewState, DataGridVirtualWindow, GridScrollPosition } from './dataGrid';
export { createDataGridClipboardPayload, formatDataGridClipboard } from './dataGridClipboard';
export type { DataGridClipboardFormat, DataGridClipboardOptions, DataGridClipboardPayload } from './dataGridClipboard';

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

/** Dialect picker shared by Web, Electron and future host adapters. */
export interface SqlDialectSelectProps {
  readonly value: DatabaseKind;
  readonly onChange: (databaseKind: DatabaseKind) => void;
  readonly ariaLabel?: string;
}

export function SqlDialectSelect({ value, onChange, ariaLabel = 'SQL dialect' }: SqlDialectSelectProps): ReactNode {
  const known = SUPPORTED_DATABASE_KINDS.includes(value as typeof SUPPORTED_DATABASE_KINDS[number]);
  return <label className="ui-sql-dialect-select">Dialect<select aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value as DatabaseKind)}>{SUPPORTED_DATABASE_KINDS.map(kind => <option key={kind} value={kind}>{DATABASE_KIND_DISPLAY_NAMES[kind] ?? kind}</option>)}{!known && <option value={value}>{DATABASE_KIND_DISPLAY_NAMES[value] ?? value}</option>}</select><small>SQL authoring profile</small></label>;
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
    return <button type="button" role="tab" key={`${result.sourceId}:${result.resultSetId}`} ref={element => { tabRefs.current[index] = element; }} tabIndex={tabIndex} aria-selected={active} data-result-status={result.status} onKeyDown={event => {
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

export interface CellValueViewerProps {
  readonly column: DataGridColumn;
  readonly value: unknown;
  readonly rowNumber?: number;
  readonly onClose: () => void;
  readonly onCopy?: () => void;
}

function cellValueViewerText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Uint8Array) return `0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
  }
  return String(value);
}

export function CellValueViewer({ column, value, rowNumber, onClose, onCopy }: CellValueViewerProps): ReactNode {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  const type = column.type ?? 'unknown';
  const meta = [`Type: ${type}`, ...(rowNumber === undefined ? [] : [`Row: ${rowNumber}`])].join(' | ');
  return <div className="ui-cell-value-viewer-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="ui-cell-value-viewer" role="dialog" aria-modal="true" aria-labelledby="ui-cell-value-viewer-title"><header className="ui-cell-value-viewer-header"><div><h2 id="ui-cell-value-viewer-title">Cell Value: {column.name}</h2><small>{meta}</small></div><button type="button" className="ui-cell-value-viewer-close" aria-label="Close cell value" onClick={onClose}>×</button></header><div className="ui-cell-value-viewer-body">{value === null || value === undefined ? <div className="ui-cell-value-viewer-null">NULL</div> : <pre>{cellValueViewerText(value)}</pre>}</div><footer className="ui-cell-value-viewer-actions">{onCopy && <button type="button" onClick={onCopy}>Copy Value</button>}<button type="button" onClick={onClose}>Close</button></footer></section></div>;
}

export function SchemaTree({ nodes, selectedId, expandedIds, onToggle, onSelect, onActivate, onInsert, onOpenQuery, onOpenExplain, onOpenDdl, onCopyDdl, onImport, onCopyName, onToggleFavorite, isFavorite, favorites = [], recent = [], searchValue = '', onSearchChange, searchResults = [], searchLoading = false, searchPlaceholder = 'Search tables, views…', filters = [], activeFilterIds = [], onFilterToggle, onRefresh, onExpandAll, onCollapseAll }: SchemaTreeProps): ReactNode {
  const expanded = new Set(expandedIds ?? []);
  const [contextMenu, setContextMenu] = useState<{ readonly node: MetadataNode; readonly clientX: number; readonly clientY: number } | undefined>(undefined);
  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (): void => setContextMenu(undefined);
    const onKeyDown = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  const openMenu = (event: ReactMouseEvent<HTMLDivElement>, node: MetadataNode): void => {
    if (node.kind !== 'object' && node.kind !== 'column') return;
    event.preventDefault();
    event.stopPropagation();
    onSelect?.(node);
    setContextMenu({ node, clientX: event.clientX, clientY: event.clientY });
  };
  const runAction = (action: ((node: MetadataNode) => void) | undefined): void => {
    const node = contextMenu?.node;
    setContextMenu(undefined);
    if (node) action?.(node);
  };
  const hasObjectActions = contextMenu?.node.kind === 'object';
  const activate = (node: MetadataNode): void => {
    onSelect?.(node);
    onActivate?.(node);
  };
  const nodeDepth = (node: MetadataNode): number => {
    const byId = new Map(nodes.map(item => [item.id, item] as const));
    let depth = 0;
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return Math.min(depth, 12);
  };
  const renderNode = (node: MetadataNode, shortcut = false): ReactNode => <div className={`ui-schema-node${shortcut ? ' ui-schema-shortcut' : ''}`} role="treeitem" aria-selected={node.id === selectedId} aria-expanded={!shortcut && node.hasChildren ? expanded.has(node.id) : undefined} key={node.id} onContextMenu={event => openMenu(event, node)} style={shortcut ? undefined : { paddingLeft: `${4 + nodeDepth(node) * 14}px` }}>
    {!shortcut && node.hasChildren && <button type="button" aria-label={`${expanded.has(node.id) ? 'Collapse' : 'Expand'} ${node.label}`} onClick={() => onToggle?.(node)}>{expanded.has(node.id) ? '▾' : '▸'}</button>}
    {!shortcut && !node.hasChildren && <span className="ui-schema-expander-placeholder" aria-hidden="true" />}
    <button type="button" title={node.description} onClick={() => activate(node)}><span className="ui-schema-glyph" aria-hidden="true">{schemaNodeGlyph(node)}</span><span>{node.label}</span>{node.kind === 'column' && node.columnType ? <small>{node.columnType}</small> : node.kind === 'object' && node.objectType ? <small>{node.objectType}</small> : null}</button>
  </div>;

  return <div className="ui-schema-tree" role="tree" aria-label="Schema">
    {(onSearchChange || onRefresh || onExpandAll || onCollapseAll) && <div className="ui-schema-toolbar">
      {onSearchChange && <label className="ui-schema-search"><span aria-hidden="true">⌕</span><input aria-label="Search schema" placeholder={searchPlaceholder} value={searchValue} onChange={event => onSearchChange(event.target.value)} /></label>}
      <div className="ui-schema-toolbar-actions">
        {onRefresh && <button type="button" aria-label="Refresh schema" title="Refresh schema" onClick={onRefresh}>↻</button>}
        {onExpandAll && <button type="button" aria-label="Expand all schema nodes" title="Expand all" onClick={() => void onExpandAll()}>＋</button>}
        {onCollapseAll && <button type="button" aria-label="Collapse all schema nodes" title="Collapse all" onClick={onCollapseAll}>−</button>}
      </div>
    </div>}
    {filters.length > 0 && <div className="ui-schema-filters" aria-label="Schema object filters">{filters.map(filter => <button type="button" key={filter.id} className={activeFilterIds.includes(filter.id) ? 'active' : ''} aria-pressed={activeFilterIds.includes(filter.id)} onClick={() => onFilterToggle?.(filter.id)}>{filter.label}</button>)}</div>}
    {(favorites.length > 0 || recent.length > 0) && <div className="ui-schema-shortcuts">
      {favorites.length > 0 && <div><div className="ui-schema-shortcuts-title">Favorites</div>{favorites.map(node => renderNode(node, true))}</div>}
      {recent.length > 0 && <div><div className="ui-schema-shortcuts-title">Recent</div>{recent.slice(0, 5).map(node => renderNode(node, true))}</div>}
    </div>}
    {searchValue.trim() ? <div className="ui-schema-search-results" aria-live="polite">
      {searchLoading ? <div className="ui-schema-empty">Searching schema…</div> : searchResults.length === 0 ? <div className="ui-schema-empty">No matching objects.</div> : searchResults.map(node => renderNode(node, true))}
    </div> : nodes.map(node => renderNode(node))}
    {contextMenu && <div className="ui-schema-context-menu" role="menu" aria-label={`Actions for ${contextMenu.node.label}`} style={{ left: contextMenu.clientX, top: contextMenu.clientY }} onClick={event => event.stopPropagation()}>
      <strong>{contextMenu.node.label}</strong>
      {onInsert && <button type="button" role="menuitem" onClick={() => runAction(onInsert)}>Insert qualified name</button>}
      {hasObjectActions && onOpenQuery && <button type="button" role="menuitem" onClick={() => runAction(onOpenQuery)}>View top 1000</button>}
      {hasObjectActions && onOpenExplain && <button type="button" role="menuitem" onClick={() => runAction(onOpenExplain)}>Explain plan</button>}
      {hasObjectActions && onOpenDdl && <button type="button" role="menuitem" onClick={() => runAction(onOpenDdl)}>Open DDL</button>}
      {hasObjectActions && onCopyDdl && <button type="button" role="menuitem" onClick={() => runAction(onCopyDdl)}>Copy DDL</button>}
      {hasObjectActions && onImport && <button type="button" role="menuitem" onClick={() => runAction(onImport)}>Import CSV/XLSX</button>}
      {onCopyName && <button type="button" role="menuitem" onClick={() => runAction(onCopyName)}>Copy qualified name</button>}
      {hasObjectActions && onToggleFavorite && <button type="button" role="menuitem" onClick={() => runAction(onToggleFavorite)}>{(isFavorite?.(contextMenu.node) ?? favorites.some(node => node.id === contextMenu.node.id)) ? 'Remove from favorites' : 'Add to favorites'}</button>}
    </div>}
  </div>;
}

function schemaNodeGlyph(node: MetadataNode): string {
  if (node.kind === 'database') return '◉';
  if (node.kind === 'schema') return '▦';
  if (node.kind === 'group') return '▰';
  if (node.kind === 'column') return '·';
  if (node.objectType?.toUpperCase() === 'VIEW') return '◌';
  if (node.objectType?.toUpperCase() === 'PROCEDURE') return 'ƒ';
  return '▤';
}

export interface HistoryViewEntry {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly sqlFingerprint: string;
  readonly sql?: string;
  readonly createdAt?: string | number;
  readonly rowCount?: number;
  readonly durationMs?: number;
  readonly connectionId?: string;
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
  readonly onActivate?: (node: MetadataNode) => void;
  readonly onInsert?: (node: MetadataNode) => void;
  readonly onOpenQuery?: (node: MetadataNode) => void;
  readonly onOpenExplain?: (node: MetadataNode) => void;
  readonly onOpenDdl?: (node: MetadataNode) => void;
  readonly onCopyDdl?: (node: MetadataNode) => void;
  readonly onImport?: (node: MetadataNode) => void;
  readonly onCopyName?: (node: MetadataNode) => void;
  readonly onToggleFavorite?: (node: MetadataNode) => void;
  readonly isFavorite?: (node: MetadataNode) => boolean;
  readonly favorites?: readonly MetadataNode[];
  readonly recent?: readonly MetadataNode[];
  readonly searchValue?: string;
  readonly onSearchChange?: (value: string) => void;
  readonly searchResults?: readonly MetadataNode[];
  readonly searchLoading?: boolean;
  readonly searchPlaceholder?: string;
  readonly filters?: readonly { readonly id: string; readonly label: string }[];
  readonly activeFilterIds?: readonly string[];
  readonly onFilterToggle?: (id: string) => void;
  readonly onRefresh?: () => void;
  readonly onExpandAll?: () => void | Promise<void>;
  readonly onCollapseAll?: () => void;
}

export interface HistoryViewProps {
  readonly entries: readonly HistoryViewEntry[];
  readonly state?: AsyncViewState;
  readonly message?: string;
  readonly onOpen?: (entry: HistoryViewEntry) => void;
  readonly onRerun?: (entry: HistoryViewEntry) => void;
  readonly onCopy?: (entry: HistoryViewEntry) => void;
  readonly onRefresh?: () => void;
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

export function HistoryView({ entries, state = 'ready', message, onOpen, onRerun, onCopy, onRefresh }: HistoryViewProps): ReactNode {
  const [filter, setFilter] = useState('');
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleEntries = normalizedFilter
    ? entries.filter(entry => [entry.label, entry.sqlFingerprint, entry.sql ?? ''].some(value => value.toLowerCase().includes(normalizedFilter)))
    : entries;
  return <section className="ui-history" aria-labelledby="ui-history-title"><header className="ui-history-header"><h2 id="ui-history-title">Query history</h2><div className="ui-history-controls"><label>Filter<input aria-label="Filter history" value={filter} onChange={event => setFilter(event.target.value)} /></label>{onRefresh && <button type="button" aria-label="Refresh history" onClick={onRefresh}>↻</button>}</div></header><AsyncStateView state={state} message={message} emptyLabel="No queries yet.">{visibleEntries.length === 0 ? <div className="ui-history-no-match" role="status">No matching queries.</div> : <div className="ui-history-list">{visibleEntries.map(entry => <article className="ui-history-entry" key={entry.id}><button type="button" className="ui-history-open" onClick={() => onOpen?.(entry)}><strong>{entry.status}</strong><span>{entry.label}</span><code>{entry.sqlFingerprint}</code></button><div className="ui-history-actions">{onRerun && <button type="button" aria-label="Run query" title={`Run ${entry.label}`} onClick={() => onRerun(entry)}>Run</button>}{onCopy && <button type="button" aria-label="Copy query" title={`Copy ${entry.label}`} onClick={() => onCopy(entry)}>Copy</button>}</div></article>)}</div>}</AsyncStateView></section>;
}

export function ExplainView({ state, plan, message, onCancel }: ExplainViewProps): ReactNode {
  return <section className="ui-explain" aria-labelledby="ui-explain-title"><h2 id="ui-explain-title">Explain</h2><AsyncStateView state={state} message={message}>{plan && <pre>{plan}</pre>}</AsyncStateView>{state === 'loading' && onCancel && <button type="button" onClick={onCancel}>Cancel</button>}</section>;
}

export function DesignerForm({ fields, capability, onChange, onPreview, onApply }: DesignerFormProps): ReactNode {
  const canPreview = capability?.status === 'available' || capability?.status === 'read-only';
  const canApply = capability?.status === 'available';
  return <section className="ui-designer" aria-labelledby="ui-designer-title"><h2 id="ui-designer-title">Designer</h2><CapabilityGate capability={capability} fallback={<div className="ui-capability-state" role="status">{capability?.reason ?? 'Designer unavailable.'}</div>}><div className="ui-designer-fields">{Object.entries(fields).map(([field, value]) => <label key={field}>{field}<input value={value} onChange={event => onChange(field, event.target.value)} /></label>)}</div><div className="ui-designer-actions"><button type="button" disabled={!canPreview} onClick={onPreview}>Preview</button><button type="button" disabled={!canApply} onClick={onApply}>Apply</button></div></CapabilityGate></section>;
}
