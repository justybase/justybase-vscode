import type * as Monaco from 'monaco-editor';
import { registerSqlShortcuts, SQL_SHORTCUTS, sqlShortcutEdit } from '../src';

describe('shared SQL shortcuts', () => {
  it('keeps the VS Code shortcut map and expands SX at a boundary', () => {
    expect(SQL_SHORTCUTS.get('SX')).toBe('SELECT');
    expect(sqlShortcutEdit('SX ', 2)).toEqual({
      startColumn: 1,
      endColumn: 4,
      text: 'SELECT ',
      cursorColumn: 8,
      triggerSuggest: true,
    });
    expect(sqlShortcutEdit('FROM SX ', 7)).toEqual({
      startColumn: 6,
      endColumn: 9,
      text: 'SELECT ',
      cursorColumn: 13,
      triggerSuggest: true,
    });
  });

  it('supports all compact clause shortcuts without rewriting identifiers', () => {
    for (const [trigger, replacement] of SQL_SHORTCUTS) {
      expect(sqlShortcutEdit(`${trigger} `, trigger.length)).toEqual(expect.objectContaining({
        text: `${replacement} `,
      }));
    }
    expect(sqlShortcutEdit('SXDIM ', 5)).toBeUndefined();
    expect(sqlShortcutEdit('orders_sx ', 9)).toBeUndefined();
  });

  it('creates the LIKE wildcard and places the cursor between percent signs', () => {
    expect(sqlShortcutEdit('WHERE name LIKE ', 15)).toEqual({
      startColumn: 12,
      endColumn: 17,
      text: "LIKE '%%'",
      cursorColumn: 19,
      triggerSuggest: false,
    });
    expect(sqlShortcutEdit('dislike ', 8)).toBeUndefined();
  });

  it('commits the caret after the native space edit', async () => {
    type Change = { text: string; range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } };
    const listeners: Array<(event: { changes: readonly Change[] }) => void> = [];
    let lineText = 'SX';
    let position = { lineNumber: 1, column: 3 };
    const triggers: string[] = [];
    const model = {
      uri: { toString: () => 'inmemory://shortcut.sql' },
      getLineContent: () => lineText,
      onDidChangeContent: (listener: (event: { changes: readonly Change[] }) => void) => {
        listeners.push(listener);
        return { dispose: () => undefined };
      },
    };
    const editor = {
      getModel: () => model,
      executeEdits: (_source: string, edits: ReadonlyArray<{ range: { startColumn: number; endColumn: number }; text: string }>, endCursorState?: (inverse: readonly unknown[]) => unknown) => {
        const edit = edits[0];
        if (!edit) return false;
        lineText = `${lineText.slice(0, edit.range.startColumn - 1)}${edit.text}${lineText.slice(edit.range.endColumn - 1)}`;
        const state = endCursorState?.([]);
        const selection = Array.isArray(state) ? state[0] as { positionLineNumber?: number; positionColumn?: number } | undefined : undefined;
        if (selection?.positionLineNumber !== undefined && selection.positionColumn !== undefined) {
          position = { lineNumber: selection.positionLineNumber, column: selection.positionColumn };
        }
        return true;
      },
      setPosition: (next: { lineNumber: number; column: number }) => { position = next; },
      trigger: (_source: string, action: string) => { triggers.push(action); },
    };
    const monaco = {
      Range: class {
        public constructor(public readonly startLineNumber: number, public readonly startColumn: number, public readonly endLineNumber: number, public readonly endColumn: number) {}
      },
      Selection: class {
        public constructor(public readonly selectionStartLineNumber: number, public readonly selectionStartColumn: number, public readonly positionLineNumber: number, public readonly positionColumn: number) {}
      },
    } as unknown as typeof Monaco;

    const registration = registerSqlShortcuts(editor as unknown as Monaco.editor.IStandaloneCodeEditor, monaco);
    lineText = 'SX ';
    listeners[0]?.({ changes: [{ text: ' ', range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 } }] });
    await new Promise<void>(resolve => queueMicrotask(resolve));

    expect(lineText).toBe('SELECT ');
    expect(position).toEqual({ lineNumber: 1, column: 8 });
    expect(triggers).toContain('editor.action.triggerSuggest');
    registration.dispose();
  });
});
