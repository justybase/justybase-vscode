/** Portable severity values used by SQL authoring hosts and the Problems UI. */
export type SqlProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Renderer-neutral SQL diagnostic location. */
export interface SqlProblem {
  readonly message: string;
  readonly severity: SqlProblemSeverity;
  readonly code?: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}
