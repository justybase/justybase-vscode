import type * as Monaco from 'monaco-editor';

/** SQL space expansions kept compatible with the VS Code editor. */
export const SQL_SHORTCUTS: ReadonlyMap<string, string> = new Map([
  ['SX', 'SELECT'],
  ['WX', 'WHERE'],
  ['GX', 'GROUP BY'],
  ['HX', 'HAVING'],
  ['OX', 'ORDER BY'],
  ['FX', 'FROM'],
  ['JX', 'JOIN'],
  ['LX', 'LIMIT'],
  ['IX', 'INSERT INTO'],
  ['UX', 'UPDATE'],
  ['DX', 'DELETE FROM'],
  ['CX', 'CREATE TABLE'],
]);

export interface SqlShortcutEdit {
  readonly startColumn: number;
  readonly endColumn: number;
  readonly text: string;
  readonly cursorColumn?: number;
  readonly triggerSuggest: boolean;
}

function isBoundaryBefore(value: string | undefined): boolean {
  return value === undefined || !/[a-zA-Z0-9_]/u.test(value);
}

/**
 * Computes the edit after a single space has already been inserted. Columns
 * in the returned edit are Monaco's one-based, end-exclusive columns.
 */
export function sqlShortcutEdit(lineText: string, spaceIndex: number): SqlShortcutEdit | undefined {
  if (spaceIndex < 0 || lineText[spaceIndex] !== ' ') return undefined;
  const beforeSpace = lineText.slice(0, spaceIndex);
  for (const [trigger, replacement] of SQL_SHORTCUTS) {
    if (!beforeSpace.toUpperCase().endsWith(trigger) || !isBoundaryBefore(beforeSpace[beforeSpace.length - trigger.length - 1])) continue;
    const startIndex = beforeSpace.length - trigger.length;
    const text = `${replacement} `;
    return {
      startColumn: startIndex + 1,
      endColumn: spaceIndex + 2,
      text,
      cursorColumn: startIndex + 1 + text.length,
      triggerSuggest: replacement === 'SELECT' || replacement === 'FROM' || replacement === 'JOIN',
    };
  }

  const likeMatch = /\b(like)\s$/iu.exec(lineText.slice(0, spaceIndex + 1));
  if (!likeMatch) return undefined;
  const startIndex = spaceIndex + 1 - likeMatch[0].length;
  return {
    startColumn: startIndex + 1,
    endColumn: spaceIndex + 2,
    text: `${likeMatch[1]} '%%'`,
    cursorColumn: startIndex + likeMatch[1].length + 4,
    triggerSuggest: false,
  };
}

/** Registers the same space-triggered SQL shortcuts in every Monaco host. */
export function registerSqlShortcuts(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): { dispose(): void } {
  const model = editor.getModel();
  if (!model) return { dispose: () => undefined };
  let disposed = false;

  const applyShortcut = (lineNumber: number, spaceIndex: number, expected: SqlShortcutEdit): void => {
    if (disposed || editor.getModel() !== model) return;
    const lineText = model.getLineContent(lineNumber);
    const current = sqlShortcutEdit(lineText, spaceIndex);
    // A second native edit may have arrived before the microtask. Never
    // rewrite a newer document state using the coordinates from the old one.
    if (!current || current.startColumn !== expected.startColumn || current.text !== expected.text) return;
    const range = new monaco.Range(lineNumber, current.startColumn, lineNumber, current.endColumn);
    const cursorColumn = current.cursorColumn;
    const applied = editor.executeEdits('justybase.sql-shortcut', [{ range, text: current.text }], () => (
      cursorColumn === undefined ? null : [new monaco.Selection(lineNumber, cursorColumn, lineNumber, cursorColumn)]
    ));
    if (!applied) return;

    // The native edit context can restore the caret from the original space
    // insertion after a model-level edit callback has returned. Explicitly
    // commit the collapsed caret after executeEdits, so `SX ` ends as
    // `SELECT |` instead of `SEL|ECT ` in the browser.
    if (cursorColumn !== undefined) {
      editor.setPosition({ lineNumber, column: cursorColumn });
    }
    if (current.triggerSuggest) editor.trigger('justybase.sql-shortcut', 'editor.action.triggerSuggest', {});
  };

  const disposable = model.onDidChangeContent(event => {
    if (event.changes.length !== 1) return;
    const change = event.changes[0];
    if (change?.text !== ' '
      || change.range.startLineNumber !== change.range.endLineNumber
      || change.range.startColumn !== change.range.endColumn) return;
    const lineNumber = change.range.startLineNumber;
    const lineText = model.getLineContent(lineNumber);
    const edit = sqlShortcutEdit(lineText, change.range.startColumn - 1);
    if (!edit) return;
    // Let Monaco finish the native insertion before replacing the compact
    // token. This makes the editor selection state deterministic across the
    // Chromium browser and Electron's WebView.
    queueMicrotask(() => applyShortcut(lineNumber, change.range.startColumn - 1, edit));
  });
  return {
    dispose: () => {
      disposed = true;
      disposable.dispose();
    },
  };
}
