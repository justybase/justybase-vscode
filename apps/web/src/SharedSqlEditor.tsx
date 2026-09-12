import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { EditorPreferences, SqlLanguageContext } from '@justybase/contracts';
import { EditorSurface, registerSqlLanguageFeatures, SqlProblemsPanel, sqlProblemsFromMarkers } from '@justybase/ui-react';
import type { SqlLanguageApi, SqlLanguageFeatureHandle, SqlProblem } from '@justybase/ui-react';

export type SharedSqlEditorProblem = SqlProblem;

interface SharedSqlEditorProps {
  readonly documentId: string;
  readonly value: string;
  readonly api: SqlLanguageApi;
  readonly preferences?: EditorPreferences | null;
  readonly getContext: () => SqlLanguageContext;
  readonly onChange: (value: string) => void;
  readonly onRun: () => void;
  readonly onReady?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  readonly onProblemsChange?: (problems: readonly SharedSqlEditorProblem[]) => void;
}

function isTestEnvironment(): boolean {
  const runtime = globalThis as typeof globalThis & { process?: { env?: { NODE_ENV?: string } } };
  return runtime.process?.env?.NODE_ENV === 'test';
}

/** Monaco/LSP editor used by the shared Web shell, with a testable textarea fallback. */
export function SharedSqlEditor({ documentId, value, api, preferences, getContext, onChange, onRun, onReady, onProblemsChange }: SharedSqlEditorProps): ReactElement {
  const runRef = useRef(onRun);
  const contextRef = useRef(getContext);
  const preferencesRef = useRef<EditorPreferences | null>(preferences ?? null);
  const languageHandleRef = useRef<SqlLanguageFeatureHandle | undefined>(undefined);
  runRef.current = onRun;
  contextRef.current = getContext;
  preferencesRef.current = preferences ?? null;

  useEffect(() => () => {
    languageHandleRef.current?.dispose();
    languageHandleRef.current = undefined;
  }, []);

  const handleMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    languageHandleRef.current?.dispose();
    languageHandleRef.current = registerSqlLanguageFeatures(editor, monaco, api, () => contextRef.current(), () => preferencesRef.current);
    onReady?.(editor, monaco);
  }, [api, onReady]);

  const handleValidate = useCallback((markers: Monaco.editor.IMarker[]): void => {
    onProblemsChange?.(sqlProblemsFromMarkers(markers));
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
  return <SqlProblemsPanel problems={problems} onSelect={onSelect} />;
}
