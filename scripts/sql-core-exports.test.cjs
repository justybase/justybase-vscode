const assert = require('node:assert/strict');
const test = require('node:test');

test('built SQL entrypoints share lexer tokens, parser classes and validators', () => {
  const core = require('@justybase/sql-core');
  const validation = require('@justybase/sql-core/validation');
  const lexer = require('@justybase/sql-core/netezza/lexer');
  const { NetezzaSqlParser } = require('@justybase/sql-core/netezza/parser');
  const { BaseSqlParser } = require('@justybase/sql-core/parser/BaseSqlParser');
  assert.equal(core.SqlLexer, lexer.SqlLexer);
  assert.equal(core.NetezzaSqlSemanticValidator, validation.NetezzaSqlSemanticValidator);
  assert.equal(Object.getPrototypeOf(NetezzaSqlParser.prototype), BaseSqlParser.prototype);
  const parsed = new NetezzaSqlParser();
  parsed.input = core.SqlLexer.tokenize('SELECT 1 FROM DB..T').tokens;
  assert.equal(parsed.input[0].tokenType, lexer.Select);
  parsed.statements();
  assert.deepEqual(parsed.errors, []);
});

test('built authoring compatibility subpaths are available without source imports', () => {
  const scan = require('@justybase/sql-core/sourceScan');
  const identifiers = require('@justybase/sql-core/netezza/identifierPattern');
  const rules = require('@justybase/sql-core/parser/queryClauseComparisonRules');
  assert.equal(scan.stripComments('SELECT 1 -- comment'), 'SELECT 1 ' + ' '.repeat('-- comment'.length));
  assert.ok(identifiers.NETEZZA_UNQUOTED_IDENTIFIER_PATTERN.test('TABLE_NAME'));
  assert.equal(typeof rules.registerQueryClauseComparisonRules, 'function');
  assert.throws(() => require('@justybase/sql-core/src/netezza/lexer'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('native ESM named imports retain the same public objects as CommonJS', async () => {
  const core = await import('@justybase/sql-core');
  const lexer = await import('@justybase/sql-core/netezza/lexer');
  const validation = await import('@justybase/sql-core/validation');
  assert.equal(typeof core.SqlLexer.tokenize, 'function');
  assert.equal(core.SqlLexer, require('@justybase/sql-core').SqlLexer);
  assert.equal(core.SqlLexer, lexer.SqlLexer);
  assert.equal(core.NetezzaSqlSemanticValidator, validation.NetezzaSqlSemanticValidator);
});
