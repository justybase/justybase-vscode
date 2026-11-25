jest.unmock('chevrotain');

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';

const SNIPPET_PATH = path.resolve(__dirname, '../../../dialects/db2/snippets/db2.code-snippets');
const GRAMMAR_PATH = path.resolve(__dirname, '../../../dialects/db2/syntaxes/db2.tmLanguage.json');

interface SnippetDefinition {
	prefix: string;
	body: string[] | string;
	description?: string;
}

/**
 * Snippets that are SQL PL fragments rather than complete statements. They are
 * inserted inside a procedure body, so wrap them in one before parsing.
 */
const PROCEDURE_BODY_PREFIXES = new Set([
	'db2-if',
	'db2-case',
	'db2-while',
	'db2-repeat',
	'db2-for',
	'db2-handler',
]);

function loadSnippets(): Record<string, SnippetDefinition> {
	return JSON.parse(fs.readFileSync(SNIPPET_PATH, 'utf8')) as Record<string, SnippetDefinition>;
}

/** Render a snippet body with every placeholder replaced by a literal. */
function renderSnippet(snippet: SnippetDefinition): string {
	const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
	return body
		.replace(/\$\{\d+:([^}]*)\}/g, '$1')
		.replace(/\$\{\d+\}/g, 'x')
		.replace(/\$\d+/g, 'x');
}

function wrapInProcedure(sql: string): string {
	return [
		'CREATE PROCEDURE p () LANGUAGE SQL',
		'BEGIN',
		sql,
		'END',
	].join('\n');
}

/**
 * Db2 snippets are product artifacts: every one must be valid Db2 SQL that the
 * strict parser accepts once placeholders are substituted, because that is
 * exactly what the user gets after tab-completing it.
 */
describe('Db2 snippet artifacts', () => {
	const snippets = loadSnippets();

	it('has a unique prefix for every snippet', () => {
		const prefixes = Object.values(snippets).map(snippet => snippet.prefix);
		expect(prefixes.length).toBeGreaterThan(0);
		expect(new Set(prefixes).size).toBe(prefixes.length);
		expect(prefixes.every(prefix => prefix.startsWith('db2-'))).toBe(true);
	});

	it.each(Object.entries(snippets))('parses snippet %s', (_name, snippet) => {
		const rendered = renderSnippet(snippet);
		const sql = PROCEDURE_BODY_PREFIXES.has(snippet.prefix)
			? wrapInProcedure(rendered)
			: rendered;
		const result = parseSqlStatements({ databaseKind: 'db2', sql });
		expect({
			sql,
			lex: result.lexResult.errors.length,
			errors: result.actionableParserErrors.map(error => error.message.split('\n')[0]),
		}).toEqual({ sql, lex: 0, errors: [] });
	});

	it('keeps the TextMate injection loadable and free of lookbehinds', () => {
		const grammar = fs.readFileSync(GRAMMAR_PATH, 'utf8');
		const parsed = JSON.parse(grammar) as {
			scopeName: string;
			injectionSelector: string;
			patterns: Array<{ name: string; match: string }>;
		};
		expect(parsed.scopeName).toBe('db2.injection');
		expect(parsed.injectionSelector).toContain('source.sql');
		expect(parsed.patterns.length).toBeGreaterThan(1);
		expect(grammar.includes('(?<')).toBe(false);
	});
});
