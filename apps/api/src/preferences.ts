import type { EditorPreferences, EditorPreferencesPatch } from '@justybase/contracts';

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  fontSize: 14,
  tabSize: 4,
  insertSpaces: true,
  wordWrap: 'off',
  minimap: false,
  lineNumbers: true,
  formatOnSave: false,
  formatOnType: false,
  keywordCase: 'upper',
  inlineTypeHints: false,
  linterEnabled: true,
  linterRules: {},
};

export function mergeEditorPreferences(value: unknown, patch?: EditorPreferencesPatch): EditorPreferences {
  const base = value && typeof value === 'object' ? value as Partial<EditorPreferences> : {};
  const incoming = patch ?? {};
  const numberOr = (candidate: unknown, fallback: number, min: number, max: number): number => typeof candidate === 'number' && Number.isFinite(candidate) ? Math.min(max, Math.max(min, Math.round(candidate))) : fallback;
  const booleanOr = (candidate: unknown, fallback: boolean): boolean => typeof candidate === 'boolean' ? candidate : fallback;
  const requestedWordWrap = incoming.wordWrap ?? base.wordWrap;
  const wordWrap: EditorPreferences['wordWrap'] = [ 'off', 'on', 'wordWrapColumn', 'bounded' ].includes(String(requestedWordWrap)) ? requestedWordWrap as EditorPreferences['wordWrap'] : DEFAULT_EDITOR_PREFERENCES.wordWrap;
  const requestedKeywordCase = incoming.keywordCase ?? base.keywordCase;
  const keywordCase: EditorPreferences['keywordCase'] = [ 'upper', 'lower', 'preserve' ].includes(String(requestedKeywordCase)) ? requestedKeywordCase as EditorPreferences['keywordCase'] : DEFAULT_EDITOR_PREFERENCES.keywordCase;
  return {
    ...DEFAULT_EDITOR_PREFERENCES,
    ...base,
    ...incoming,
    fontSize: numberOr(incoming.fontSize ?? base.fontSize, DEFAULT_EDITOR_PREFERENCES.fontSize, 10, 32),
    tabSize: numberOr(incoming.tabSize ?? base.tabSize, DEFAULT_EDITOR_PREFERENCES.tabSize, 1, 16),
    insertSpaces: booleanOr(incoming.insertSpaces ?? base.insertSpaces, DEFAULT_EDITOR_PREFERENCES.insertSpaces),
    wordWrap,
    minimap: booleanOr(incoming.minimap ?? base.minimap, DEFAULT_EDITOR_PREFERENCES.minimap),
    lineNumbers: booleanOr(incoming.lineNumbers ?? base.lineNumbers, DEFAULT_EDITOR_PREFERENCES.lineNumbers),
    formatOnSave: booleanOr(incoming.formatOnSave ?? base.formatOnSave, DEFAULT_EDITOR_PREFERENCES.formatOnSave),
    formatOnType: booleanOr(incoming.formatOnType ?? base.formatOnType, DEFAULT_EDITOR_PREFERENCES.formatOnType),
    keywordCase,
    inlineTypeHints: booleanOr(incoming.inlineTypeHints ?? base.inlineTypeHints, DEFAULT_EDITOR_PREFERENCES.inlineTypeHints),
    linterEnabled: booleanOr(incoming.linterEnabled ?? base.linterEnabled, DEFAULT_EDITOR_PREFERENCES.linterEnabled),
    linterRules: { ...DEFAULT_EDITOR_PREFERENCES.linterRules, ...(base.linterRules ?? {}), ...(patch?.linterRules ?? {}) },
  };
}
