import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { DATABASE_KIND_DISPLAY_NAMES, SUPPORTED_DATABASE_KINDS, type CapabilityDescriptor, type DatabaseErrorDetails, type DatabaseKind } from '@justybase/contracts';
import { compactSqlErrorMessage, buildSqlErrorLineExcerpt, DATABASE_DIAGNOSTIC_LABELS, SCHEMA_CONTEXT_MENU_LABELS, type MetadataNode } from '@justybase/ui-core';
import type { UiExecutionState, UiResultSurfaceState } from '@justybase/ui-core';
import type { UiResultViewState } from '@justybase/ui-core';
import { formatDataGridCellValue } from './dataGrid';
import type { DataGridColumn } from './dataGrid';
import { MenuIcon } from './menuIcons';
import type { ResultAnalysisKind } from './resultAnalysis';
export { DataGrid, formatDataGridCellValue, ResultGrid } from './dataGrid';
export type { DataGridCellContext, DataGridCellEdit, DataGridColumn, DataGridColumnFilterRequest, DataGridCopyPayload, DataGridProps, DataGridSelection, DataGridSelectionRange, DataGridViewState, DataGridVirtualWindow, GridScrollPosition } from './dataGrid';
export { createDataGridClipboardPayload, formatDataGridClipboard } from './dataGridClipboard';
export { downloadBlobFile } from './download';
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

export interface ErrorDiagnosticsProps {
  readonly details: DatabaseErrorDetails;
}

/**
 * Backend diagnostics for a failed statement. SQLSTATE and severity stay
 * visible; detail and hint are collapsible because they are often long. The
 * driver's raw payload is never part of the contract.
 */
export function ErrorDiagnostics({ details }: ErrorDiagnosticsProps): ReactNode {
  const [copied, setCopied] = useState(false);
  const lines: Array<[string, string]> = [];
  if (details.code) lines.push(['SQLSTATE', details.code]);
  if (details.severity) lines.push(['Severity', details.severity]);
  if (details.position !== undefined) lines.push(['Position', String(details.position)]);
  const collapsible: Array<[string, string]> = [];
  if (details.detail) collapsible.push(['Detail', details.detail]);
  if (details.hint) collapsible.push(['Hint', details.hint]);
  if (details.context) collapsible.push(['Context', details.context]);
  for (const [key, value] of Object.entries(details.diagnostics ?? {})) {
    collapsible.push([DATABASE_DIAGNOSTIC_LABELS[key] ?? key, value]);
  }
  if (lines.length === 0 && collapsible.length === 0) return null;
  const copy = (): void => {
    const text = [...lines, ...collapsible].map(([label, value]) => `${label}: ${value}`).join('\n');
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, () => undefined);
  };
  return <section className="ui-error-diagnostics" aria-label="Backend diagnostics">
    {lines.length > 0 && <dl className="ui-error-diagnostic-summary">{lines.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {collapsible.length > 0 && <details className="ui-error-diagnostic-details"><summary>Backend diagnostics detail</summary><dl>{collapsible.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>}
    <button type="button" className="ui-error-diagnostics-copy" onClick={copy}>{copied ? 'Copied' : 'Copy diagnostics'}</button>
  </section>;
}

export type ResultExecutionBannerStatus = 'idle' | 'loading' | 'finalizing' | 'retrying' | 'cancelled' | 'error' | 'success';

export interface ResultExecutionBannerProps {
  readonly status: ResultExecutionBannerStatus;
  readonly message?: string;
  readonly cancelling?: boolean;
  readonly onCancel?: () => void;
}

/**
 * Compact execution lifecycle strip for the shared result panel. The legacy
 * panel kept this information in a separate DOM banner; shared mode owns the
 * same status surface so Cancel is never hidden behind the grid.
 */
export function ResultExecutionBanner({ status, message, cancelling = false, onCancel }: ResultExecutionBannerProps): ReactNode {
  if (status === 'idle' || status === 'success') return null;
  const label = status === 'loading'
    ? 'Running query…'
    : status === 'finalizing'
      ? 'Finalizing result…'
      : status === 'retrying'
        ? 'Retrying query…'
        : status === 'cancelled'
          ? 'Query cancelled.'
          : message ?? 'Query failed.';
  const canCancel = onCancel !== undefined && (status === 'loading' || status === 'retrying');
  return <div className={`ui-execution-banner ui-execution-${status}`} role={status === 'error' ? 'alert' : 'status'} aria-live="polite">
    <span className="ui-execution-banner-icon" aria-hidden="true">{status === 'cancelled' ? '⊘' : status === 'error' ? '✗' : '▶'}</span>
    <span className="ui-execution-banner-message">{label}</span>
    {canCancel && <button type="button" className="ui-execution-banner-cancel" disabled={cancelling} onClick={onCancel}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>}
  </div>;
}

export interface ResultLimitBannerProps {
  readonly limitReached: boolean;
  readonly limit: number;
  readonly rowCount?: number;
  readonly onDismiss?: () => void;
}

export function ResultLimitBanner({ limitReached, limit, rowCount, onDismiss }: ResultLimitBannerProps): ReactNode {
  if (!limitReached) return null;
  return <div className="ui-result-limit-banner" role="alert">
    <span className="ui-result-limit-icon" aria-hidden="true">!</span>
    <span>Query row limit of {limit.toLocaleString('en-US')} rows was reached{rowCount === undefined ? '' : ` (${rowCount.toLocaleString('en-US')} rows loaded)`}. Increase <code>justybase.query.rowLimit</code> to fetch more.</span>
    {onDismiss && <button type="button" className="ui-result-limit-dismiss" aria-label="Dismiss row limit warning" onClick={onDismiss}>×</button>}
  </div>;
}

export interface ResultRefreshFailureBannerProps {
  readonly message: string;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
}

export function ResultRefreshFailureBanner({ message, onRetry, onDismiss }: ResultRefreshFailureBannerProps): ReactNode {
  return <div className="ui-refresh-failure-banner" role="alert">
    <span className="ui-refresh-failure-icon" aria-hidden="true">!</span>
    <span className="ui-refresh-failure-message">Refresh failed: {message}</span>
    {onRetry && <button type="button" onClick={onRetry}>Retry refresh</button>}
    {onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
  </div>;
}

export interface ResultErrorViewProps {
  readonly message?: string;
  readonly details?: DatabaseErrorDetails;
  /** Submitted SQL, used to render a psql-style line excerpt at `details.position`. */
  readonly sql?: string;
  /** Prepares a Copilot Chat prompt for this error; omitted when no SQL is available. */
  readonly onFixWithAi?: () => void;
  readonly children?: ReactNode;
}

function resultErrorNextSteps(message: string | undefined): string | undefined {
  const text = (message ?? '').toLowerCase();
  if (/(connect|connection|socket|network|timeout|host|port)/u.test(text)) return 'Check that the server is running and reachable (host/port, VPN or SSH tunnel), then retry. Review Logs for details.';
  if (/(syntax|parse|unexpected token|near |found .*\(at char \d+\))/u.test(text)) return 'Review the SQL near the reported position, fix it, and run the query again.';
  if (/(permission|denied|privilege|not authorized)/u.test(text)) return 'Check the object and schema permissions for the active connection, then retry.';
  if (/(not found|does not exist|unknown column|unknown table)/u.test(text)) return 'Verify the object name, schema and search path, then retry.';
  return undefined;
}

export function ResultErrorView({ message, details, sql, onFixWithAi, children }: ResultErrorViewProps): ReactNode {
  const nextSteps = resultErrorNextSteps(message);
  const displayMessage = message === undefined ? 'Something went wrong.' : compactSqlErrorMessage(message);
  const hasFullMessage = message !== undefined && displayMessage !== message;
  const fullDetails = hasFullMessage ? <details className="ui-result-error-raw"><summary>Show full error details</summary><pre>{message}</pre></details> : undefined;
  const excerpt = sql !== undefined && details?.position !== undefined
    ? buildSqlErrorLineExcerpt(sql, details.position)
    : undefined;
  return <section className="ui-result-error" role="alert" aria-label="Result error">
    <div className="ui-result-error-message">{displayMessage}</div>
    {fullDetails}
    {excerpt && <pre className="ui-result-error-excerpt">{`LINE ${excerpt.line}: ${excerpt.text}\n${' '.repeat(Math.min(excerpt.caret, excerpt.text.length))}^`}</pre>}
    {nextSteps && <p className="ui-result-error-next">{nextSteps}</p>}
    {onFixWithAi && <div className="ui-result-error-actions">
      <button
        type="button"
        className="ui-result-error-fix"
        title="Prepare a Copilot Chat prompt with the SQL, error and referenced table DDL"
        onClick={onFixWithAi}
      >Fix with Copilot</button>
    </div>}
    {details && <ErrorDiagnostics details={details} />}
    {children}
  </section>;
}

export interface RefreshLimitDialogProps {
  readonly sql?: string;
  readonly initialLimit?: string;
  readonly onSubmit: (limit: string) => void;
  readonly onCancel: () => void;
}

/** Refresh-time LIMIT editor matching the legacy trailing-LIMIT workflow. */
export function RefreshLimitDialog({ sql, initialLimit = '', onSubmit, onCancel }: RefreshLimitDialogProps): ReactNode {
  const [limit, setLimit] = useState(initialLimit);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);
  const submit = (): void => {
    if (!/^\d+$/u.test(limit.trim())) return;
    onSubmit(limit.trim());
  };
  return <div className="ui-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <section className="ui-refresh-limit-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-refresh-limit-title">
      <header><h2 id="ui-refresh-limit-title">Refresh limit</h2><button type="button" aria-label="Close refresh limit" onClick={onCancel}>×</button></header>
      <p>The query ends with a LIMIT. Choose the limit for this refresh.</p>
      {sql && <pre className="ui-refresh-limit-sql">{sql}</pre>}
      <label>LIMIT<input autoFocus inputMode="numeric" value={limit} onChange={event => setLimit(event.target.value.replace(/[^\d]/gu, ''))} onKeyDown={event => { if (event.key === 'Enter') submit(); }} /></label>
      <footer><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" disabled={!/^\d+$/u.test(limit.trim())} onClick={submit}>Refresh</button></footer>
    </section>
  </div>;
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
  /** Optional: hosts that already render a title bar can omit the shell header. */
  readonly title?: string;
  readonly className?: string;
  readonly activeSurface: string;
  readonly onSurfaceChange?: (surface: string) => void;
  readonly surfaces?: readonly { readonly id: string; readonly label: string }[];
  readonly sidebar?: ReactNode;
  readonly children: ReactNode;
}

export function UiShell({ title, className, activeSurface, onSurfaceChange, surfaces = [], sidebar, children }: UiShellProps): ReactNode {
  return <div className={['ui-shell', className].filter(Boolean).join(' ')} data-active-surface={activeSurface}>
    {(title || surfaces.length > 0) && <header className="ui-shell-header">
      {title && <h1>{title}</h1>}
      {surfaces.length > 0 && <nav aria-label="Workspace surfaces">{surfaces.map(surface => <button type="button" key={surface.id} aria-current={surface.id === activeSurface ? 'page' : undefined} onClick={() => onSurfaceChange?.(surface.id)}>{surface.label}</button>)}</nav>}
    </header>}
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

/** Dialect picker shared by host adapters. */
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

export function ResultTabs({ results, activeResultSetId, activeSourceId, onSelect, execution, getLabel, isPinned, onTogglePin, onClose }: ResultTabsProps): ReactNode {
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
    const statement = execution?.statements[result.statementIndex];
    const label = getLabel?.(result, index) ?? `Result ${index + 1}`;
    const pinned = isPinned?.(result) === true;
    return <div className={`ui-result-tab${active ? ' ui-result-tab-active' : ''}${pinned ? ' ui-result-tab-pinned' : ''}`} key={`${result.sourceId}:${result.resultSetId}`}>
      <button type="button" role="tab" className="ui-result-tab-label" ref={element => { tabRefs.current[index] = element; }} tabIndex={tabIndex} aria-selected={active} data-result-status={result.status} data-statement-index={result.statementIndex} data-statement-status={statement?.status} title={statement ? `Statement ${result.statementIndex + 1}: ${statement.status}` : undefined} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? results.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + results.length) % results.length;
        focusTab(nextIndex);
      }} onClick={() => onSelect(result.resultSetId, result.sourceId)}>{label}{result.status === 'streaming' ? ' · streaming' : ''}{result.status === 'error' ? <span className="ui-result-tab-badge ui-result-tab-badge-error">Error</span> : result.status === 'cancelled' ? <span className="ui-result-tab-badge ui-result-tab-badge-partial">Partial</span> : result.status === 'empty' ? <span className="ui-result-tab-badge ui-result-tab-badge-empty">Empty</span> : null}</button>
      {onTogglePin && <button
        type="button"
        className="ui-result-tab-pin"
        aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
        aria-pressed={pinned}
        title={pinned ? 'Unpin this result (pinned — kept across re-runs)' : 'Pin this result (keep across re-runs)'}
        onClick={() => onTogglePin(result)}
      ><MenuIcon name="pin" /></button>}
      {onClose && <button type="button" className="ui-result-tab-close" aria-label={`Close ${label}`} title="Close this result" onClick={() => onClose(result)}>×</button>}
    </div>;
  })}</div>;
}

export type ResultLayoutKind = 'table' | 'charts' | 'mini-charts' | 'diff' | 'explore' | 'analytical' | 'pivot';

export interface ResultLayoutSwitcherProps {
  readonly active: ResultLayoutKind;
  readonly onSelect: (layout: ResultLayoutKind) => void;
  readonly busy?: boolean;
}

/**
 * Legacy-style layout switcher: Table is the grid, Analyze opens the analysis
 * layouts. Kept as its own component so the toolbar stays product-neutral.
 */
export function ResultLayoutSwitcher({ active, onSelect, busy = false }: ResultLayoutSwitcherProps): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const choose = (layout: ResultLayoutKind): void => {
    setOpen(false);
    onSelect(layout);
  };
  return <div className="ui-result-layout-switcher" ref={rootRef} role="group" aria-label="Result view">
    <button
      type="button"
      className={`ui-result-layout-btn${active === 'table' ? ' active' : ''}`}
      aria-pressed={active === 'table'}
      onClick={() => choose('table')}
    >Table</button>
    <div className="ui-result-layout-analyze">
      <button
        type="button"
        className={`ui-result-layout-btn${active !== 'table' ? ' active' : ''}`}
        aria-label="Analyze"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen(value => !value)}
      >Analyze <span aria-hidden="true">▾</span></button>
      {open && <div className="ui-result-layout-menu" role="menu" aria-label="Analysis views">
        <button type="button" role="menuitemradio" aria-checked={active === 'charts'} onClick={() => choose('charts')}>Charts</button>
        <button type="button" role="menuitemradio" aria-checked={active === 'mini-charts'} onClick={() => choose('mini-charts')}>Mini Charts</button>
        <button type="button" role="menuitemradio" aria-checked={active === 'diff'} onClick={() => choose('diff')}>Diff</button>
        <button type="button" role="menuitemradio" aria-checked={active === 'explore'} onClick={() => choose('explore')}>Explore</button>
        <button type="button" role="menuitemradio" aria-checked={active === 'analytical'} onClick={() => choose('analytical')}>Analytical</button>
        <button type="button" role="menuitemradio" aria-checked={active === 'pivot'} onClick={() => choose('pivot')}>Pivot…</button>
      </div>}
    </div>
  </div>;
}

export interface ResultViewToolbarProps {
  readonly columns: readonly { readonly name: string }[];
  readonly view: Pick<UiResultViewState, 'globalFilter' | 'sorting' | 'grouping' | 'aggregation' | 'pivotColumn'>;
  readonly onChange: (patch: Partial<UiResultViewState>) => void;
  readonly onRefresh?: () => void;
  readonly onCopy?: () => void;
  readonly onCopyAll?: () => void;
  readonly copyingAll?: boolean;
  readonly copyAllLabel?: string;
  readonly onExport?: () => void;
  /** Optional adapter actions for the shared analysis surface. */
  readonly onAggregate?: () => void;
  readonly onGroup?: () => void;
  readonly onPivot?: () => void;
  /** Opens the vertical comparison of the selected rows (legacy Row View). */
  readonly onRowView?: () => void;
  readonly rowViewActive?: boolean;
  readonly activeAnalysis?: ResultAnalysisKind;
  readonly analysisBusy?: boolean;
  readonly columnMenu?: ReactNode;
  /** Optional find/jump column control rendered next to the column menu. */
  readonly columnFinder?: ReactNode;
  /** Layout switcher or other view selector rendered before the table controls. */
  readonly leading?: ReactNode;
  /** Adapter-owned actions (editing, formatting) rendered with the shared controls. */
  readonly actions?: ReactNode;
  /** Total logical rows, rendered as the legacy "N rows" status at the end. */
  readonly rowCount?: number;
  /** Hides the aggregate/group/pivot analysis actions for non-tabular results such as Logs. */
  readonly showAnalysis?: boolean;
  /** Hides the table filter/sort controls for non-tabular results such as Logs. */
  readonly showTableControls?: boolean;
  /** Hides the toolbar sort shortcut; column headers remain sortable. */
  readonly showSort?: boolean;
  /** Hides the toolbar group shortcut; header actions and the grouping panel remain. */
  readonly showGroup?: boolean;
}

/** Product-neutral controls for the common result view state. */
export function ResultViewToolbar({ columns, view, onChange, onRefresh, onCopy, onCopyAll, copyingAll = false, copyAllLabel, onExport, onAggregate, onGroup, onPivot, onRowView, rowViewActive = false, activeAnalysis, analysisBusy = false, columnMenu, columnFinder, leading, actions, rowCount, showAnalysis = true, showTableControls = true, showSort = true, showGroup = true }: ResultViewToolbarProps): ReactNode {
  const firstColumn = columns[0]?.name;
  const canSelectColumn = firstColumn !== undefined;
  const aggregateActive = activeAnalysis === 'aggregate' || (activeAnalysis === undefined && view.aggregation !== undefined);
  const groupActive = activeAnalysis === 'group' || (activeAnalysis === undefined && view.grouping.length > 0);
  const pivotActive = activeAnalysis === 'pivot' || (activeAnalysis === undefined && view.pivotColumn !== undefined);
  const sortDescending = view.sorting[0]?.descending === true;
  return <div className="ui-result-toolbar" role="toolbar" aria-label="Result view controls">
    {leading}
    {showTableControls && <div className="ui-result-toolbar-search">
      <span className="ui-result-toolbar-search-icon" aria-hidden="true"><MenuIcon name="search" /></span>
      <input aria-label="Filter results" placeholder="Search all columns…" value={view.globalFilter} onChange={event => onChange({ globalFilter: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onChange({ globalFilter: '' }); } }} />
    </div>}
    {showTableControls && showSort && <button type="button" className="ui-result-toolbar-icon" aria-label="Sort" title={view.sorting.length > 0 ? (sortDescending ? 'Sort ascending' : 'Sort descending') : 'Sort ascending'} aria-pressed={view.sorting.length > 0} disabled={!canSelectColumn && view.sorting.length === 0} onClick={() => onChange({ sorting: view.sorting.length > 0 ? (sortDescending ? [] : [{ column: view.sorting[0]?.column ?? firstColumn ?? '', descending: true }]) : firstColumn === undefined ? [] : [{ column: firstColumn, descending: false }] })}><MenuIcon name={view.sorting.length > 0 && sortDescending ? 'arrow-down' : 'arrow-up'} /></button>}
    {showAnalysis && showGroup && <button type="button" className="ui-result-toolbar-icon" aria-label="Group" title="Group" aria-pressed={groupActive} disabled={analysisBusy || (!canSelectColumn && view.grouping.length === 0)} onClick={() => onGroup ? onGroup() : onChange({ grouping: view.grouping.length > 0 ? [] : firstColumn === undefined ? [] : [firstColumn] })}><MenuIcon name="layers" /></button>}
    {showAnalysis && <button type="button" className="ui-result-toolbar-icon" aria-label="Aggregate" title="Aggregate" aria-pressed={aggregateActive} disabled={analysisBusy} onClick={() => onAggregate ? onAggregate() : onChange({ aggregation: view.aggregation === undefined ? 'count' : undefined })}><MenuIcon name="bar-chart" /></button>}
    {showAnalysis && <button type="button" className="ui-result-toolbar-icon" aria-label="Pivot" title="Pivot: choose rows, columns, values and aggregation" aria-pressed={pivotActive} disabled={analysisBusy || (!canSelectColumn && view.pivotColumn === undefined)} onClick={() => onPivot ? onPivot() : onChange({ pivotColumn: view.pivotColumn === undefined ? firstColumn : undefined })}><MenuIcon name="git-branch" /></button>}
    {onRowView && <button type="button" className="ui-result-toolbar-icon" aria-label="Row View" title="Row View (select 1–10 rows to compare vertically)" aria-pressed={rowViewActive} onClick={onRowView}><MenuIcon name="rows" /></button>}
    {onRefresh && <button type="button" className="ui-result-toolbar-icon" aria-label="Refresh" title="Refresh" onClick={onRefresh}><MenuIcon name="refresh" /></button>}
    {onCopy && <button type="button" className="ui-result-toolbar-icon" aria-label="Copy" title="Copy" onClick={onCopy}><MenuIcon name="copy" /></button>}
    {onCopyAll && <button type="button" className="ui-result-toolbar-icon" aria-label={copyAllLabel ?? 'Copy full result (all rows)'} title={copyingAll ? 'Copying all rows…' : 'Copy every filtered row from the server spool, not just the loaded page'} disabled={copyingAll} onClick={onCopyAll}><MenuIcon name="file-spreadsheet" /></button>}
    {onExport && <button type="button" className="ui-result-toolbar-icon" aria-label="Export" title="Export" onClick={onExport}><MenuIcon name="download" /></button>}
    {actions}
    {columnFinder}
    {columnMenu}
    {rowCount !== undefined && <span className="ui-result-toolbar-row-count" role="status">{rowCount.toLocaleString()} rows</span>}
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

export function SchemaTree({ nodes, selectedId, expandedIds, onToggle, onSelect, onActivate, onInsert, onSetActiveContext, onRefreshNode, onOpenQuery, onOpenExplain, onOpenEditData, onOpenDesigner, onOpenDdl, onCopyDdl, onImport, onCopyName, onToggleFavorite, isFavorite, favorites = [], recent = [], searchValue = '', onSearchChange, searchResults = [], searchLoading = false, searchPlaceholder = 'Search tables, views…', filters = [], activeFilterIds = [], onFilterToggle, onRefresh, onExpandAll, onCollapseAll }: SchemaTreeProps): ReactNode {
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
    // Database, schema and object nodes all represent usable SQL name
    // segments. Keep the context menu available for them; restricting it to
    // objects made the tree look interactive while silently dropping the
    // actions users need most often (copy/insert qualified name).
    if (node.kind === 'group') return;
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
  const hasQualifiedName = contextMenu !== undefined && contextMenu.node.kind !== 'group';
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
      {(contextMenu.node.kind === 'database' || contextMenu.node.kind === 'schema') && onSetActiveContext && <button type="button" role="menuitem" onClick={() => runAction(onSetActiveContext)}>{SCHEMA_CONTEXT_MENU_LABELS.setActiveContext}</button>}
      {contextMenu.node.hasChildren && onRefreshNode && <button type="button" role="menuitem" onClick={() => runAction(onRefreshNode)}>{SCHEMA_CONTEXT_MENU_LABELS.refreshSelectedMetadata}</button>}
      {hasQualifiedName && onInsert && <button type="button" role="menuitem" onClick={() => runAction(onInsert)}>{SCHEMA_CONTEXT_MENU_LABELS.insertQualifiedName}</button>}
      {hasQualifiedName && onCopyName && <button type="button" role="menuitem" onClick={() => runAction(onCopyName)}>{SCHEMA_CONTEXT_MENU_LABELS.copyName}</button>}
      {hasObjectActions && onOpenQuery && <button type="button" role="menuitem" onClick={() => runAction(onOpenQuery)}>{SCHEMA_CONTEXT_MENU_LABELS.selectTop1000}</button>}
      {hasObjectActions && onOpenExplain && <button type="button" role="menuitem" onClick={() => runAction(onOpenExplain)}>{SCHEMA_CONTEXT_MENU_LABELS.explainPlan}</button>}
      {hasObjectActions && onOpenEditData && <button type="button" role="menuitem" onClick={() => runAction(onOpenEditData)}>{SCHEMA_CONTEXT_MENU_LABELS.viewEditData}</button>}
      {hasObjectActions && onOpenDesigner && <button type="button" role="menuitem" onClick={() => runAction(onOpenDesigner)}>{SCHEMA_CONTEXT_MENU_LABELS.openObjectDesigner}</button>}
      {hasObjectActions && onOpenDdl && <button type="button" role="menuitem" onClick={() => runAction(onOpenDdl)}>{SCHEMA_CONTEXT_MENU_LABELS.createDdlCode}</button>}
      {hasObjectActions && onCopyDdl && <button type="button" role="menuitem" onClick={() => runAction(onCopyDdl)}>{SCHEMA_CONTEXT_MENU_LABELS.copyDdl}</button>}
      {hasObjectActions && onImport && <button type="button" role="menuitem" onClick={() => runAction(onImport)}>{SCHEMA_CONTEXT_MENU_LABELS.importData}</button>}
      {hasObjectActions && onToggleFavorite && <button type="button" role="menuitem" onClick={() => runAction(onToggleFavorite)}>{(isFavorite?.(contextMenu.node) ?? favorites.some(node => node.id === contextMenu.node.id)) ? SCHEMA_CONTEXT_MENU_LABELS.removeFromFavorites : SCHEMA_CONTEXT_MENU_LABELS.addToFavorites}</button>}
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
  readonly execution?: UiExecutionState;
  /** Host-specific tab labels (for example the Logs result set). */
  readonly getLabel?: (result: UiResultSurfaceState, index: number) => string | undefined;
  /** Whole-result pins survive re-runs; the host decides which IDs are pinned. */
  readonly isPinned?: (result: UiResultSurfaceState) => boolean;
  readonly onTogglePin?: (result: UiResultSurfaceState) => void;
  readonly onClose?: (result: UiResultSurfaceState) => void;
}

export interface SchemaTreeProps {
  readonly nodes: readonly MetadataNode[];
  readonly selectedId?: string;
  readonly expandedIds?: readonly string[];
  readonly onToggle?: (node: MetadataNode) => void;
  readonly onSelect?: (node: MetadataNode) => void;
  readonly onActivate?: (node: MetadataNode) => void;
  readonly onInsert?: (node: MetadataNode) => void;
  readonly onSetActiveContext?: (node: MetadataNode) => void;
  readonly onRefreshNode?: (node: MetadataNode) => void;
  readonly onOpenQuery?: (node: MetadataNode) => void;
  readonly onOpenExplain?: (node: MetadataNode) => void;
  readonly onOpenEditData?: (node: MetadataNode) => void;
  readonly onOpenDesigner?: (node: MetadataNode) => void;
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
