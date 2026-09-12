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
    return {
      startColumn: startIndex + 1,
      endColumn: spaceIndex + 2,
      text: `${replacement} `,
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
    model.pushEditOperations([], [{
      range: new monaco.Range(lineNumber, edit.startColumn, lineNumber, edit.endColumn),
      text: edit.text,
    }], () => edit.cursorColumn === undefined ? null : [new monaco.Selection(lineNumber, edit.cursorColumn, lineNumber, edit.cursorColumn)]);
    if (edit.triggerSuggest) editor.trigger('justybase.sql-shortcut', 'editor.action.triggerSuggest', {});
  });
  return disposable;
}
