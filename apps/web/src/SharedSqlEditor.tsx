import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { EditorPreferences, SqlLanguageContext } from '@justybase/contracts';
import { EditorSurface, disposeSqlLanguageFeatures, registerSqlLanguageFeatures } from '@justybase/ui-react';
import type { SqlLanguageApi } from '@justybase/ui-react';

export interface SharedSqlEditorProblem {
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly code?: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

interface SharedSqlEditorProps {
  readonly documentId: string;
  readonly value: string;
  readonly api: SqlLanguageApi;
  readonly preferences?: EditorPreferences | null;
  readonly getContext: () => SqlLanguageContext;
  readonly onChange: (value: string) => void;
  readonly onRun: () => void;
  readonly onProblemsChange?: (problems: readonly SharedSqlEditorProblem[]) => void;
}

function isTestEnvironment(): boolean {
  const runtime = globalThis as typeof globalThis & { process?: { env?: { NODE_ENV?: string } } };
  return runtime.process?.env?.NODE_ENV === 'test';
}

function markerSeverity(severity: Monaco.MarkerSeverity): SharedSqlEditorProblem['severity'] {
  if (severity === 8) return 'error';
  if (severity === 4) return 'warning';
  if (severity === 2) return 'info';
  return 'hint';
}

function markerCode(code: Monaco.editor.IMarker['code']): string | undefined {
  if (typeof code === 'string') return code;
  return code && typeof code.value === 'string' ? code.value : undefined;
}

function toProblem(marker: Monaco.editor.IMarker): SharedSqlEditorProblem {
  return {
    message: marker.message,
    severity: markerSeverity(marker.severity),
    code: markerCode(marker.code),
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
  };
}

/** Monaco/LSP editor used by the shared Web shell, with a testable textarea fallback. */
export function SharedSqlEditor({ documentId, value, api, preferences, getContext, onChange, onRun, onProblemsChange }: SharedSqlEditorProps): ReactElement {
  const runRef = useRef(onRun);
  const contextRef = useRef(getContext);
  const preferencesRef = useRef<EditorPreferences | null>(preferences ?? null);
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  runRef.current = onRun;
  contextRef.current = getContext;
  preferencesRef.current = preferences ?? null;

  useEffect(() => () => {
    if (monacoRef.current) disposeSqlLanguageFeatures(monacoRef.current);
  }, []);

  const handleMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void => {
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    registerSqlLanguageFeatures(editor, monaco, api, () => contextRef.current(), () => preferencesRef.current);
  }, [api]);

  const handleValidate = useCallback((markers: Monaco.editor.IMarker[]): void => {
    onProblemsChange?.(markers.map(toProblem));
  }, [onProblemsChange]);

  if (isTestEnvironment()) return <EditorSurface value={value} label="SQL editor" onChange={onChange} onSubmit={onRun} /> as ReactElement;

  return <section className="shared-sql-editor" aria-label="SQL editor">
    <Editor
      height="100%"
      path={`inmemory://web/${encodeURIComponent(documentId)}.sql`}
      language="sql"
      theme="vs-dark"
      value={value}
      onChange={next => onChange(next ?? '')}
      onMount={handleMount}
      onValidate={handleValidate}
      options={{
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        folding: true,
        fontSize: preferences?.fontSize ?? 14,
        tabSize: preferences?.tabSize ?? 4,
        insertSpaces: preferences?.insertSpaces ?? true,
        wordWrap: preferences?.wordWrap ?? 'off',
        lineNumbers: preferences?.lineNumbers === false ? 'off' : 'on',
        minimap: { enabled: preferences?.minimap ?? false },
        formatOnType: preferences?.formatOnType ?? false,
        padding: { top: 10, bottom: 8 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        suggest: { showMethods: true, showFunctions: true, showKeywords: true, showSnippets: true },
      }}
    />
  </section>;
}

export function SharedSqlProblems({ problems, onSelect }: { readonly problems: readonly SharedSqlEditorProblem[]; readonly onSelect?: (problem: SharedSqlEditorProblem) => void }): ReactElement {
  return <section className="shared-sql-problems" aria-label="SQL Problems">
    <header><strong>Problems</strong><span>{problems.length}</span></header>
    {problems.length === 0
      ? <div className="shared-sql-problems-empty">No SQL problems detected.</div>
      : <div className="shared-sql-problems-list">{problems.map((problem, index) => <button type="button" key={`${problem.code ?? 'problem'}:${problem.startLineNumber}:${problem.startColumn}:${index}`} onClick={() => onSelect?.(problem)}>
        <span className={`shared-sql-problem-severity shared-sql-problem-${problem.severity}`}>{problem.severity === 'error' ? '×' : problem.severity === 'warning' ? '!' : '·'}</span>
        <span><strong>{problem.code ?? problem.severity}</strong> {problem.message}</span><small>Ln {problem.startLineNumber}, Col {problem.startColumn}</small>
      </button>)}</div>}
  </section>;
}
