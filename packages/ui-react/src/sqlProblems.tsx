import type { ReactElement } from 'react';
import type { SqlProblem } from '@justybase/ui-core';

export type { SqlProblem, SqlProblemSeverity } from '@justybase/ui-core';

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
