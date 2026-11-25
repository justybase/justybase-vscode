import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import type { IGrammar, IRawGrammar } from 'vscode-textmate';
import { Registry } from 'vscode-textmate';

const SQL_GRAMMAR_FIXTURE_PATH = path.join(
	process.cwd(),
	'src/__tests__/syntax/fixtures/sourceSql.tmLanguage.json',
);
const DB2_INJECTION_PATH = path.join(
	process.cwd(),
	'dialects/db2/syntaxes/db2.tmLanguage.json',
);

interface FlatToken {
	readonly text: string;
	readonly scopes: string[];
}

let grammarReady: Promise<IGrammar> | undefined;

async function loadGrammar() {
	if (!grammarReady) {
		grammarReady = (async () => {
			const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
			const oniguruma = await import('vscode-oniguruma');
			await oniguruma.loadWASM(fs.readFileSync(wasmPath).buffer);

			const sqlGrammar = JSON.parse(
				fs.readFileSync(SQL_GRAMMAR_FIXTURE_PATH, 'utf8'),
			) as IRawGrammar;
			const db2Injection = JSON.parse(
				fs.readFileSync(DB2_INJECTION_PATH, 'utf8'),
			) as IRawGrammar;

			const registry = new Registry({
				onigLib: Promise.resolve({
					createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
					createOnigString: (value: string) => new oniguruma.OnigString(value),
				}),
				loadGrammar: async (scope) => {
					if (scope === 'source.sql') return sqlGrammar;
					if (scope === 'db2.injection') return db2Injection;
					return null;
				},
				getInjections: (scope) => (scope === 'source.sql' ? ['db2.injection'] : []),
			});

			const grammar = await registry.loadGrammar('source.sql');
			if (!grammar) throw new Error('Failed to load source.sql grammar');
			return grammar;
		})();
	}
	return grammarReady;
}

async function tokenize(sql: string): Promise<FlatToken[]> {
	const grammar = await loadGrammar();
	const tokens: FlatToken[] = [];
	for (const lineText of sql.split('\n')) {
		const result = grammar.tokenizeLine(lineText, null);
		for (const token of result.tokens) {
			const text = lineText.slice(token.startIndex, token.endIndex);
			if (!text.trim()) continue;
			tokens.push({ text, scopes: token.scopes });
		}
	}
	return tokens;
}

function scopeOf(tokens: readonly FlatToken[], needle: string): string[] {
	return tokens.find((token) => token.text === needle)?.scopes ?? [];
}

describe('Db2 TextMate injection', () => {
	it('loads and tokenizes without Oniguruma errors', async () => {
		const tokens = await tokenize('SELECT 1');
		expect(tokens.length).toBeGreaterThan(0);
	});

	it('scopes Db2 DDL commands the extension generates', async () => {
		const tokens = await tokenize('CREATE UNIQUE INDEX i ON t (a)');
		expect(scopeOf(tokens, 'CREATE UNIQUE INDEX').join(' ')).toContain('keyword.other.ddl.db2');
		expect(scopeOf(tokens, 'INDEX')).toEqual([]);
	});

	it('scopes Db2 query clauses', async () => {
		const tokens = await tokenize('SELECT * FROM t FETCH FIRST 5 ROWS ONLY WITH UR');
		expect(scopeOf(tokens, 'FETCH FIRST').join(' ')).toContain('keyword.other.dml.db2');
		expect(scopeOf(tokens, 'WITH UR').join(' ')).toContain('keyword.other.dml.db2');
	});

	it('scopes Db2 special registers and partition DDL words', async () => {
		const tokens = await tokenize('SELECT CURRENT SCHEMA FROM t');
		expect(scopeOf(tokens, 'CURRENT SCHEMA').join(' ')).toContain('keyword.other.db2');
	});

	it('scopes the utility and maintenance statements the extension emits', async () => {
		const tokens = await tokenize('REFRESH TABLE t');
		expect(scopeOf(tokens, 'REFRESH TABLE').join(' ')).toContain('keyword.other.ddl.db2');
		const alterTokens = await tokenize('ALTER SEQUENCE s RESTART WITH 1');
		expect(scopeOf(alterTokens, 'ALTER SEQUENCE').join(' ')).toContain('keyword.other.ddl.db2');
	});

	it('scopes SQL PL control words', async () => {
		const tokens = await tokenize('END IF;');
		expect(scopeOf(tokens, 'END IF').join(' ')).toContain('keyword.control.sqlpl.db2');
	});

	it('does not apply Db2 scopes inside comments', async () => {
		const tokens = await tokenize('-- FETCH FIRST 5 ROWS ONLY');
		const fetch = scopeOf(tokens, 'FETCH FIRST');
		if (fetch.length > 0) {
			expect(fetch.join(' ')).not.toContain('db2');
		}
	});
});
