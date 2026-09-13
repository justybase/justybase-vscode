import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { EditorPreferences, SqlLanguageContext } from '@justybase/contracts';
import { configureSqlMonacoTheme, registerSqlLanguageFeatures, sqlProblemsFromMarkers } from '@justybase/ui-monaco';
import type { SqlLanguageApi, SqlLanguageFeatureHandle } from '@justybase/ui-monaco';
import { EditorSurface, SqlProblemsPanel } from '@justybase/ui-react';
import type { SqlProblem } from '@justybase/ui-core';

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
  const changeRef = useRef(onChange);
  const problemsRef = useRef(onProblemsChange);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const localValueRef = useRef(value);
  const documentIdRef = useRef(documentId);
  const lastValuePropRef = useRef(value);
  const pendingChangeRef = useRef<{ documentId: string; value: string; apply: (value: string) => void } | undefined>(undefined);
  const changeTimerRef = useRef<number | undefined>(undefined);
  const preferencesRef = useRef<EditorPreferences | null>(preferences ?? null);
  const languageHandleRef = useRef<SqlLanguageFeatureHandle | undefined>(undefined);
  runRef.current = onRun;
  contextRef.current = getContext;
  changeRef.current = onChange;
  problemsRef.current = onProblemsChange;
  preferencesRef.current = preferences ?? null;

  const flushPendingChange = useCallback((): void => {
    const timer = changeTimerRef.current;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      changeTimerRef.current = undefined;
    }
    const pending = pendingChangeRef.current;
    pendingChangeRef.current = undefined;
    pending?.apply(pending.value);
  }, []);

  const scheduleChange = useCallback((nextValue: string): void => {
    pendingChangeRef.current = { documentId: documentIdRef.current, value: nextValue, apply: changeRef.current };
    const timer = changeTimerRef.current;
    if (timer !== undefined) window.clearTimeout(timer);
    changeTimerRef.current = window.setTimeout(flushPendingChange, 240);
  }, [flushPendingChange]);

  useEffect(() => () => {
    flushPendingChange();
    languageHandleRef.current?.dispose();
    languageHandleRef.current = undefined;
    editorRef.current = null;
  }, [flushPendingChange]);

  const handleMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco): void => {
    monaco.editor.setTheme(configureSqlMonacoTheme(monaco));
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    languageHandleRef.current?.dispose();
    languageHandleRef.current = registerSqlLanguageFeatures(editor, monaco, api, () => contextRef.current(), () => preferencesRef.current);
    onReady?.(editor, monaco);
    const blurDisposable = editor.onDidBlurEditorText(() => flushPendingChange());
    editor.onDidDispose(() => blurDisposable.dispose());
  }, [api, flushPendingChange, onReady]);

  const handleChange = useCallback((next: string | undefined): void => {
    const nextValue = next ?? '';
    localValueRef.current = nextValue;
    scheduleChange(nextValue);
  }, [scheduleChange]);
  const handleValidate = useCallback((markers: Monaco.editor.IMarker[]): void => {
    problemsRef.current?.(sqlProblemsFromMarkers(markers));
  }, []);
  const editorOptions = useMemo(() => ({
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    folding: true,
    // The shared provider coalesces remote requests; preserve VS Code-like
    // quick suggestions after a short pause.
    quickSuggestions: { other: true, comments: false, strings: false },
    quickSuggestionsDelay: 180,
    // Do not let an async completion popup consume a punctuation/whitespace
    // key from the native input stream while the user is typing.
    acceptSuggestionOnCommitCharacter: false,
    suggestOnTriggerCharacters: true,
    fontSize: preferences?.fontSize ?? 14,
    tabSize: preferences?.tabSize ?? 4,
    insertSpaces: preferences?.insertSpaces ?? true,
    wordWrap: preferences?.wordWrap ?? 'off',
    lineNumbers: preferences?.lineNumbers === false ? 'off' as const : 'on' as const,
    minimap: { enabled: preferences?.minimap ?? false },
    formatOnType: preferences?.formatOnType ?? false,
    padding: { top: 10, bottom: 8 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    'semanticHighlighting.enabled': true,
    suggest: { showMethods: true, showFunctions: true, showKeywords: true, showSnippets: true },
  }), [preferences?.fontSize, preferences?.formatOnType, preferences?.insertSpaces, preferences?.lineNumbers, preferences?.minimap, preferences?.tabSize, preferences?.wordWrap]);

  useEffect(() => {
    if (documentIdRef.current !== documentId) {
      flushPendingChange();
      documentIdRef.current = documentId;
      lastValuePropRef.current = value;
      localValueRef.current = value;
      return;
    }
    const previousValue = lastValuePropRef.current;
    lastValuePropRef.current = value;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || model.getValue() === value) {
      localValueRef.current = value;
      return;
    }
    // Preserve the live Monaco model during unrelated parent renders while a
    // local typing burst is waiting for its debounced durable-state update.
    if (value === previousValue) return;
    localValueRef.current = value;
    editor.executeEdits('external-sql-update', [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }]);
  }, [documentId, flushPendingChange, value]);

  if (isTestEnvironment()) return <EditorSurface value={value} label="SQL editor" onChange={onChange} onSubmit={onRun} /> as ReactElement;

  return <section className="shared-sql-editor" aria-label="SQL editor">
    <Editor
      height="100%"
      path={`inmemory://web/${encodeURIComponent(documentId)}.sql`}
      language="sql"
      theme="justybase-sql-dark"
      defaultValue={value}
      onChange={handleChange}
      onMount={handleMount}
      onValidate={handleValidate}
      options={editorOptions}
    />
  </section>;
}

export function SharedSqlProblems({ problems, onSelect }: { readonly problems: readonly SharedSqlEditorProblem[]; readonly onSelect?: (problem: SharedSqlEditorProblem) => void }): ReactElement {
  return <SqlProblemsPanel problems={problems} onSelect={onSelect} />;
}
