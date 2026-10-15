jest.unmock('chevrotain');

import { createHash } from 'node:crypto';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionTriggerKind } from 'vscode-languageserver/node';
import editors from './fixtures/postgresqlEditorConformance.json';
import parsers from './fixtures/postgresqlConformance.json';
import fixtures from './fixtures/postgresqlMetadataFixtures.json';
import provenance from './fixtures/postgresqlConformanceProvenance.json';
import { LspCompletionEngine, type CompletionMetadataProvider } from '../../server/completionEngine';
import { MetadataBridge } from '../../server/metadataBridge';
import { provideHover } from '../../server/hoverEngine';
import { resolveColumnIdentityWithMetadata } from '../../server/handlers/symbolHandlers';
import { findFunctionCall } from '../../server/signatureHelpUtils';
import { parseSemanticScopeWithParser } from '../../providers/parsers/parserSqlContext';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { SqlParser } from '../../sql/sqlParser';
import { SqlValidator } from '../../sqlParser/validator';
import type { SchemaProvider } from '../../sqlParser/schemaProvider';
import { postgresqlSqlAuthoring } from '../../../packages/dialect-utils/src/authoring/postgresql';
import { resolveSqlRenameSymbol } from '@justybase/sql-core/validation/symbols';

interface EditorCase {
  id: string;
  sql: string;
  contract: string;
  cursorMarker?: string;
  metadataFixture?: keyof typeof fixtures;
  expect: {
    statementCount?: number; statementTypes?: string[];
    contains?: { label: string }[] | string; containsSignature?: string; activeParameter?: number;
    notContains?: { label: string }[]; exact?: { label: string }[];
    diagnostics?: { containsCodes?: string[]; notContainsCodes?: string[] };
  };
}
const fixture = fixtures['postgresql/authoring'];
const database = fixture.databases[0];
const schema = database.schemas[0];
const table = (name: string) => schema.tables.find(item => item.name === name);
const context = {
  connectionName: 'postgresql-fixture', effectiveDatabase: database.name,
  effectiveSchema: schema.name, databaseKind: 'postgresql' as const, ...fixture.executionContext,
};
const schemaProvider: SchemaProvider = {
  getTable: (_db, _schema, name) => {
    const relation = table(name);
    return relation ? { name, schema: schema.name, database: database.name, isCte: false, isTempTable: false,
      columns: relation.columns.map(column => ({ name: column.name, dataType: column.type })) } : undefined;
  },
  tableExists: (_db, _schema, name) => !!table(name),
};
const provider: CompletionMetadataProvider = {
  getContext: async () => context,
  getDatabases: async () => [{ name: database.name }],
  getSchemas: async () => [{ name: schema.name }],
  getTables: async () => schema.tables.map(item => ({ name: item.name, schema: schema.name, database: database.name })),
  getViews: async () => [],
  getProcedures: async () => [],
  getColumns: async (_uri, _db, name) => table(name)?.columns ?? [],
};
function bridge(): MetadataBridge {
  return new MetadataBridge(async params => {
    if (params.kind === 'context') return context;
    if (params.kind === 'tableInfo' || params.kind === 'cachedTableInfo') {
      const relation = table(params.table ?? '');
      return { table: params.table ?? '', schema: schema.name, database: database.name,
        exists: !!relation, columns: relation?.columns ?? [], columnsComplete: true };
    }
    return null;
  });
}

describe('PostgreSQL canonical editor contracts (offline)', () => {
  it('locks the canonical IDs and exported content hash', () => {
    expect(createHash('sha256').update(JSON.stringify({ parsers, editors, fixtures })).digest('hex')).toBe(provenance.contentHash);
    expect(new Set([...parsers, ...editors].map(item => item.id)).size).toBe(provenance.caseCount);
  });
  it.each(editors as EditorCase[])('$id', async testCase => {
    const cursor = testCase.cursorMarker ? testCase.sql.indexOf(testCase.cursorMarker) : testCase.sql.length;
    const sql = testCase.cursorMarker ? testCase.sql.replace(testCase.cursorMarker, '') : testCase.sql;
    const document = TextDocument.create('file:///postgresql-contract.sql', 'sql', 1, sql);
    const engine = new LspCompletionEngine(provider);
    switch (testCase.contract) {
      case 'recovery':
        expect(() => parseSemanticScopeWithParser(sql, cursor, 'postgresql')).not.toThrow();
        await expect(engine.provideCompletionItems(document, document.positionAt(cursor), CompletionTriggerKind.Invoked)).resolves.toBeDefined();
        break;
      case 'statement': {
        const statements = SqlParser.splitStatements(sql, 'postgresql');
        expect(statements).toHaveLength(testCase.expect.statementCount!);
        const types = statements.map(statement => {
          const parsed = parseSqlStatements({ sql: statement, databaseKind: 'postgresql' });
          expect(parsed.actionableParserErrors).toEqual([]);
          const child = parsed.cst?.children.statement?.[0];
          const rule = child && 'children' in child ? Object.keys(child.children)[0] : '';
          return /Create|^create/.test(rule) ? 'create' : /^alter/.test(rule) ? 'alter' : /^with/.test(rule) ? 'select' : rule.replace(/Statement$/, '').toLowerCase();
        });
        expect(types).toEqual(testCase.expect.statementTypes);
        break;
      }
      case 'diagnostics': {
        const executionContext = fixtures[testCase.metadataFixture ?? 'postgresql/authoring'].executionContext;
        const result = new SqlValidator(schemaProvider, postgresqlSqlAuthoring.validation, executionContext).validate(sql);
        const codes = [...result.errors, ...result.warnings].map(issue => issue.code);
        for (const code of testCase.expect.diagnostics?.containsCodes ?? []) expect(codes).toContain(code);
        for (const code of testCase.expect.diagnostics?.notContainsCodes ?? []) expect(codes).not.toContain(code);
        break;
      }
      case 'completion': {
        const items = await engine.provideCompletionItems(document, document.positionAt(cursor), CompletionTriggerKind.Invoked);
        const labels = items.map(item => item.label);
        for (const item of (testCase.expect.contains ?? []) as { label: string }[]) expect(labels).toContain(item.label);
        for (const item of testCase.expect.notContains ?? []) expect(labels).not.toContain(item.label);
        if (testCase.expect.exact) expect(labels).toEqual(testCase.expect.exact.map(item => item.label));
        break;
      }
      case 'signature': {
        const call = findFunctionCall(sql.slice(sql.lastIndexOf('\n', cursor - 1) + 1, cursor));
        expect(call).toBeDefined();
        const signatures = postgresqlSqlAuthoring.signatures.get(call!.functionName.toUpperCase());
        expect(signatures?.map(signature => signature.name + '(' + signature.parameters.join(', ') + ')')).toContain(testCase.expect.containsSignature);
        expect(call!.argumentPosition).toBe(testCase.expect.activeParameter);
        break;
      }
      case 'hover': {
        const metadata = bridge();
        const hover = await provideHover(document, { position: document.positionAt(cursor) }, {
          resolveSqlRenameSymbol: (source, offset) => resolveSqlRenameSymbol(source, offset, parseSqlStatements({ sql: source, databaseKind: 'postgresql' })),
          getStatementAtPosition: (source, offset) => SqlParser.getStatementAtPosition(source, offset, undefined, 'postgresql'),
          getAliasBindings: (source, offset) => parseSemanticScopeWithParser(source, offset, 'postgresql').preferredAliasBindings,
          getCompletionLocalDefinitions: (source, _statement, _statementOffset, _kind, offset) => parseSemanticScopeWithParser(source, offset, 'postgresql').visibleLocalDefinitions,
          findLocalDefinition: (definitions, name) => definitions.find(item => item.name === name),
          formatObjectPath: (db, sch, name) => [db, sch, name].filter(Boolean).join('.'),
          isCancellationRequested: () => false,
          resolveColumnIdentity: offset => resolveColumnIdentityWithMetadata(document, offset, metadata, context),
        }, metadata);
        expect(hover).not.toBeNull();
        expect(JSON.stringify(hover?.contents)).toContain(testCase.expect.contains as string);
        break;
      }
      default: throw new Error('Unsupported PostgreSQL editor contract: ' + testCase.contract);
    }
  });
});
