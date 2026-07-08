import * as fs from 'fs';
import * as path from 'path';
import type { IGrammar, IRawGrammar, IToken } from 'vscode-textmate';
import { Registry } from 'vscode-textmate';

export interface FlatToken {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly scopes: string[];
}

const SQL_GRAMMAR_FIXTURE_PATH = path.join(
  process.cwd(),
  'src/__tests__/syntax/fixtures/sourceSql.tmLanguage.json',
);
const NETEZZA_INJECTION_PATH = path.join(
  process.cwd(),
  'dialects/netezza/syntaxes/netezza.tmLanguage.json',
);

let grammarReady: Promise<IGrammar> | undefined;

async function loadGrammar(): Promise<IGrammar> {
  if (!grammarReady) {
    grammarReady = (async () => {
      const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
      const oniguruma = await import('vscode-oniguruma');
      await oniguruma.loadWASM(fs.readFileSync(wasmPath).buffer);

      const sqlGrammar = JSON.parse(
        fs.readFileSync(SQL_GRAMMAR_FIXTURE_PATH, 'utf8'),
      ) as IRawGrammar;
      const netezzaInjection = JSON.parse(
        fs.readFileSync(NETEZZA_INJECTION_PATH, 'utf8'),
      ) as IRawGrammar;

      const registry = new Registry({
        onigLib: Promise.resolve({
          createOnigScanner: (patterns: string[]) =>
            new oniguruma.OnigScanner(patterns),
          createOnigString: (str: string) => oniguruma.createOnigString(str),
        }),
        loadGrammar: async (scope) => {
          if (scope === 'source.sql') {
            return sqlGrammar;
          }
          if (scope === 'netezza.injection') {
            return netezzaInjection;
          }
          return null;
        },
        getInjections: (scope) =>
          scope === 'source.sql' ? ['netezza.injection'] : [],
      });

      const grammar = await registry.loadGrammar('source.sql');
      if (!grammar) {
        throw new Error('Failed to load source.sql grammar');
      }
      return grammar;
    })();
  }
  return grammarReady;
}

export async function tokenizeSql(sql: string): Promise<FlatToken[]> {
  const grammar = await loadGrammar();
  const lines = sql.split('\n');
  const flat: FlatToken[] = [];
  let stack = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex] ?? '';
    const result = grammar.tokenizeLine(lineText, stack);
    stack = result.ruleStack;
    for (const token of result.tokens as IToken[]) {
      const text = lineText.slice(token.startIndex, token.endIndex);
      if (!text.trim()) {
        continue;
      }
      flat.push({
        line: lineIndex + 1,
        start: token.startIndex,
        end: token.endIndex,
        text,
        scopes: token.scopes,
      });
    }
  }

  return flat;
}

export function isCommentToken(token: FlatToken): boolean {
  return token.scopes.some((scope) => scope.includes('comment'));
}

export function isStringToken(token: FlatToken): boolean {
  return token.scopes.some((scope) => scope.includes('string.quoted'));
}

export function tokensMatching(
  tokens: readonly FlatToken[],
  predicate: (token: FlatToken) => boolean,
): FlatToken[] {
  return tokens.filter(predicate);
}

export function findTokenContaining(
  tokens: readonly FlatToken[],
  needle: string,
  options?: { onlyActiveCode?: boolean },
): FlatToken | undefined {
  return tokens.find((token) => {
    if (options?.onlyActiveCode && (isCommentToken(token) || isStringToken(token))) {
      return false;
    }
    return token.text.includes(needle);
  });
}
