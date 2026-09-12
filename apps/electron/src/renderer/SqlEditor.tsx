import { useCallback, useRef } from 'react';
import type { ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { EditorPreferences, SqlLanguageContext } from '@justybase/contracts';
import { EditorSurface, registerSqlLanguageFeatures, SqlProblemsPanel, sqlProblemsFromMarkers } from '@justybase/ui-react';
import type { SqlLanguageApi, SqlProblem } from '@justybase/ui-react';

export type SqlEditorProblem = SqlProblem;

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
    onProblemsChange?.(sqlProblemsFromMarkers(markers));
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
  return <SqlProblemsPanel problems={problems} onSelect={onSelect} />;
}
