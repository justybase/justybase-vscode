import { useCallback, useRef } from 'react';
import type { ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { EditorPreferences, SqlLanguageContext } from '@justybase/contracts';
import { EditorSurface, registerSqlLanguageFeatures } from '@justybase/ui-react';
import type { SqlLanguageApi } from '@justybase/ui-react';

export interface SqlEditorProblem {
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly code?: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface SqlEditorProps {
  readonly documentId: string;
  readonly value: string;
  readonly api: SqlLanguageApi;
  readonly preferences: EditorPreferences | null;
  readonly getContext: () => SqlLanguageContext;
  readonly onChange: (value: string) => void;
  readonly onRun: () => void;
  readonly onReady?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  readonly onProblemsChange?: (problems: readonly SqlEditorProblem[]) => void;
}

function markerSeverity(severity: Monaco.MarkerSeverity): SqlEditorProblem['severity'] {
  if (severity === 8) return 'error';
  if (severity === 4) return 'warning';
  if (severity === 2) return 'info';
  return 'hint';
}

function markerCode(code: Monaco.editor.IMarker['code']): string | undefined {
  if (typeof code === 'string') return code;
  if (code && typeof code.value === 'string') return code.value;
  return undefined;
}

function toProblem(marker: Monaco.editor.IMarker): SqlEditorProblem {
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

/** Monaco boundary shared by the Electron workspace and its Problems view. */
export function SqlEditor({ documentId, value, api, preferences, getContext, onChange, onRun, onReady, onProblemsChange }: SqlEditorProps): ReactElement {
  const runRef = useRef(onRun);
  const contextRef = useRef(getContext);
  const preferencesRef = useRef(preferences);
  runRef.current = onRun;
  contextRef.current = getContext;
  preferencesRef.current = preferences;

  const handleMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    registerSqlLanguageFeatures(editor, monaco, api, () => contextRef.current(), () => preferencesRef.current);
    onReady?.(editor, monaco);
  }, [api, onReady]);

  const handleValidate = useCallback((markers: Monaco.editor.IMarker[]): void => {
    onProblemsChange?.(markers.map(toProblem));
  }, [onProblemsChange]);

  // Jest/jsdom and the deterministic React unit suite do not provide a
  // layout-capable Monaco worker. Production Electron always takes the
  // Monaco branch; the fallback keeps the state/controller contract directly
  // testable without replacing the production editor in live gates.
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    return <EditorSurface value={value} label="SQL editor" onChange={onChange} onSubmit={onRun} /> as ReactElement;
  }

  return <section className="electron-sql-editor" aria-label="SQL editor">
    <Editor
      height="100%"
      path={`inmemory://electron/${encodeURIComponent(documentId)}.sql`}
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

export function ProblemsPanel({ problems, onSelect }: { readonly problems: readonly SqlEditorProblem[]; readonly onSelect?: (problem: SqlEditorProblem) => void }): ReactElement {
  return <section className="electron-problems" aria-label="SQL Problems">
    <header><strong>Problems</strong><span className="electron-problems-count">{problems.length}</span></header>
    {problems.length === 0
      ? <div className="electron-problems-empty">No SQL problems detected.</div>
      : <div className="electron-problems-list">{problems.map((problem, index) => <button type="button" className={`electron-problem electron-problem-${problem.severity}`} key={`${problem.code ?? 'problem'}:${problem.startLineNumber}:${problem.startColumn}:${index}`} onClick={() => onSelect?.(problem)}>
        <span className="electron-problem-severity">{problem.severity === 'error' ? '×' : problem.severity === 'warning' ? '!' : '·'}</span>
        <span className="electron-problem-copy"><span><strong>{problem.code ?? problem.severity}</strong> {problem.message}</span><small>Ln {problem.startLineNumber}, Col {problem.startColumn}</small></span>
      </button>)}</div>}
  </section>;
}
