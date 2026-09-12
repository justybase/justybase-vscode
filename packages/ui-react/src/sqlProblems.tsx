import type * as Monaco from 'monaco-editor';
import type { ReactElement } from 'react';

export type SqlProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface SqlProblem {
  readonly message: string;
  readonly severity: SqlProblemSeverity;
  readonly code?: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

function markerSeverity(severity: Monaco.MarkerSeverity): SqlProblemSeverity {
  if (severity === 8) return 'error';
  if (severity === 4) return 'warning';
  if (severity === 2) return 'info';
  return 'hint';
}

function markerCode(code: Monaco.editor.IMarker['code']): string | undefined {
  if (typeof code === 'string') return code;
  return code && typeof code.value === 'string' ? code.value : undefined;
}

/** Converts Monaco diagnostics to the platform-neutral Problems contract. */
export function sqlProblemsFromMarkers(markers: readonly Monaco.editor.IMarker[]): readonly SqlProblem[] {
  return markers.map(marker => ({
    message: marker.message,
    severity: markerSeverity(marker.severity),
    code: markerCode(marker.code),
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
  }));
}

export interface SqlProblemsPanelProps {
  readonly problems: readonly SqlProblem[];
  readonly onSelect?: (problem: SqlProblem) => void;
  readonly className?: string;
}

/** Shared Problems view used by the Web, Electron and future host adapters. */
export function SqlProblemsPanel({ problems, onSelect, className = '' }: SqlProblemsPanelProps): ReactElement {
  const panelClassName = ['ui-sql-problems', className].filter(Boolean).join(' ');
  return <section className={panelClassName} aria-label="SQL Problems">
    <header><strong>Problems</strong><span>{problems.length}</span></header>
    {problems.length === 0
      ? <div className="ui-sql-problems-empty">No SQL problems detected.</div>
      : <div className="ui-sql-problems-list">{problems.map((problem, index) => <button type="button" className="ui-sql-problem" key={`${problem.code ?? 'problem'}:${problem.startLineNumber}:${problem.startColumn}:${index}`} onClick={() => onSelect?.(problem)}>
        <span className={`ui-sql-problem-severity ui-sql-problem-${problem.severity}`}>{problem.severity === 'error' ? '×' : problem.severity === 'warning' ? '!' : '·'}</span>
        <span className="ui-sql-problem-copy"><span><strong>{problem.code ?? problem.severity}</strong> {problem.message}</span><small>Ln {problem.startLineNumber}, Col {problem.startColumn}</small></span>
      </button>)}</div>}
  </section>;
}
