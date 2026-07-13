/**
 * SQL interaction performance — parse-call guards and session cache reuse.
 *
 * Complements editorTypingResponsiveness.test.ts (cursor/typing hot path) by
 * asserting that semantic coloring, hover, and completion statement lookup
 * do not multiply full-document parses per user gesture.
 *
 * Run with:
 *   npx jest src/__tests__/performance/sqlInteractionPerformance.test.ts --runInBand
 */

import { jest } from '@jest/globals';

jest.unmock('chevrotain');
jest.mock('vscode', () => jest.requireActual('../__mocks__/vscode'));

import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { collectIdentifierOccurrences } from '../../providers/parsers/identifierRoleCollector';
import * as parserSqlContext from '../../providers/parsers/parserSqlContext';
import { NetezzaSemanticTokensProvider } from '../../providers/semanticTokensProvider';
import { NetezzaDocumentLinkProvider } from '../../providers/documentLinkProvider';
import { NetezzaDocumentSymbolProvider } from '../../providers/documentSymbolProvider';
import { CompletionContextExtractor } from '../../server/completionContextExtractor';
import { SqlParser } from '../../sql/sqlParser';
import { DocumentParseSession } from '../../sqlParser/documentParseSession';
import { SqlLexer } from '../../sqlParser/lexer';
import * as parsingRuntime from '../../sqlParser/parsingRuntime';
import { resolveSqlRenameSymbol } from '../../sqlParser/symbols';
import { SqlDataAffordanceResolver } from '../../providers/sqlDataAffordanceResolver';
import type { ConnectionManager } from '../../core/connectionManager';
import type { MetadataCache } from '../../metadataCache';
import {
  createLargeSqlDocument,
} from './largeDdlTestHelpers';

const SAMPLE_SQL = [
  'WITH cte AS (SELECT id, name FROM src)',
  'SELECT c.id, c.name FROM cte c JOIN orders o ON c.id = o.customer_id;',
  'SELECT COUNT(*) FROM orders WHERE status = 1;',
].join('\n');

class MockDocumentLink {
  public tooltip?: string;
  constructor(
    public range: vscode.Range,
    public target?: vscode.Uri,
  ) {}
}

function patchVscodeConstructors(): void {
  (vscode as unknown as { DocumentLink: typeof MockDocumentLink }).DocumentLink =
    MockDocumentLink;
  (vscode.Uri as unknown as { parse: (value: string) => vscode.Uri }).parse =
    jest.fn((value: string) => ({
      toString: () => value,
      fsPath: value,
    })) as unknown as typeof vscode.Uri.parse;
}

describe('SQL interaction performance', () => {
  beforeAll(() => {
    patchVscodeConstructors();
  });

  describe('semantic tokens', () => {
    it('performs one full-document parse per tokenize invocation', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        undefined,
        session,
      );
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///semantic-single-parse.sql',
      );

      try {
        provider.provideDocumentSemanticTokens(
          document,
          { isCancellationRequested: false } as vscode.CancellationToken,
        );
        expect(spy).toHaveBeenCalledTimes(1);

        spy.mockClear();
        provider.provideDocumentSemanticTokens(
          document,
          { isCancellationRequested: false } as vscode.CancellationToken,
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('does not call parseSemanticScopeWithParser from semantic token path', () => {
      const scopeSpy = jest.spyOn(parserSqlContext, 'parseSemanticScopeWithParser');
      const session = new DocumentParseSession();
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        undefined,
        session,
      );
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///semantic-no-double-scope.sql',
      );

      try {
        provider.provideDocumentSemanticTokens(
          document,
          { isCancellationRequested: false } as vscode.CancellationToken,
        );
        expect(scopeSpy).not.toHaveBeenCalled();
      } finally {
        scopeSpy.mockRestore();
      }
    });

    it('repeated semantic token refresh on same version reuses parse session', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        undefined,
        session,
      );
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///semantic-session-reuse.sql',
      );
      const token = { isCancellationRequested: false } as vscode.CancellationToken;

      try {
        provider.provideDocumentSemanticTokens(document, token);
        expect(spy.mock.calls.length).toBeGreaterThan(0);

        spy.mockClear();
        for (let i = 0; i < 20; i++) {
          provider.provideDocumentSemanticTokens(document, token);
        }

        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('coalesces 300 rapid document versions and publishes only the latest', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        undefined,
        session,
        150,
      );
      const requests: Array<Promise<vscode.SemanticTokens>> = [];

      try {
        for (let version = 1; version <= 300; version++) {
          const sql = `${SAMPLE_SQL}\n-- edit ${version}`;
          const base = createLargeSqlDocument(sql, 'file:///semantic-burst.sql');
          const document = { ...base, version } as vscode.TextDocument;
          requests.push(Promise.resolve(provider.provideDocumentSemanticTokens(
            document,
            { isCancellationRequested: false } as vscode.CancellationToken,
          )));
        }

        jest.advanceTimersByTime(150);
        const results = await Promise.all(requests);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(results.slice(0, -1).every((result) => result.data.length === 0)).toBe(true);
        expect(results[results.length - 1]?.data.length).toBeGreaterThan(0);
        expect(session.getCacheSizes().parses).toBe(1);
      } finally {
        provider.dispose();
        spy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('restarts same-version pending work after the previous caller is cancelled', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        undefined,
        new DocumentParseSession(),
        150,
      );
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///semantic-cancelled-replacement.sql',
      );
      const firstToken = { isCancellationRequested: false };
      const replacementToken = { isCancellationRequested: false };

      try {
        const firstRequest = Promise.resolve(
          provider.provideDocumentSemanticTokens(
            document,
            firstToken as vscode.CancellationToken,
          ),
        );
        firstToken.isCancellationRequested = true;
        const replacementRequest = Promise.resolve(
          provider.provideDocumentSemanticTokens(
            document,
            replacementToken as vscode.CancellationToken,
          ),
        );

        jest.advanceTimersByTime(150);
        const [firstResult, replacementResult] = await Promise.all([
          firstRequest,
          replacementRequest,
        ]);

        expect(firstResult.data.length).toBe(0);
        expect(replacementResult.data.length).toBeGreaterThan(0);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        provider.dispose();
        spy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('uses lexer-only coloring above the large-script threshold', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        undefined,
        new DocumentParseSession(),
        0,
      );
      const sql = `SELECT builtin_col FROM source_table;\n${'-- padding\n'.repeat(16_000)}`;
      const document = createLargeSqlDocument(sql, 'file:///semantic-large.sql');

      try {
        const result = provider.provideDocumentSemanticTokens(
          document,
          { isCancellationRequested: false } as vscode.CancellationToken,
        );
        expect(result).not.toBeInstanceOf(Promise);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        provider.dispose();
        spy.mockRestore();
      }
    });

    it('does not recompute documents on unaffected metadata connections', () => {
      const session = new DocumentParseSession();
      const connectionManager = {
        getConnectionForExecution: jest.fn((uri: string) =>
          uri.includes('connection-a') ? 'A' : 'B'),
        getExecutionDatabaseKind: jest.fn(() => 'netezza'),
      } as unknown as ConnectionManager;
      const provider = new NetezzaSemanticTokensProvider(
        undefined,
        connectionManager,
        session,
        0,
      );
      const documentA = createLargeSqlDocument(SAMPLE_SQL, 'file:///connection-a.sql');
      const documentB = createLargeSqlDocument(SAMPLE_SQL, 'file:///connection-b.sql');
      const token = { isCancellationRequested: false } as vscode.CancellationToken;

      try {
        const initialA = provider.provideDocumentSemanticTokens(documentA, token);
        const initialB = provider.provideDocumentSemanticTokens(documentB, token);

        provider.refresh('A');
        const refreshedA = provider.provideDocumentSemanticTokens(documentA, token);
        const refreshedB = provider.provideDocumentSemanticTokens(documentB, token);

        expect(refreshedA).not.toBe(initialA);
        expect(refreshedB).toBe(initialB);
      } finally {
        provider.dispose();
      }
    });
  });

  describe('parse cache bounds', () => {
    it('retains only the current parse and sixteen scopes per active document', () => {
      const session = new DocumentParseSession();
      const uri = 'file:///changing-document.sql';
      for (let version = 1; version <= 300; version++) {
        const sql = `SELECT ${version} AS value;`;
        session.getParseResult({ documentUri: uri, documentVersion: version, sql });
      }

      const currentSql = 'SELECT value FROM source_table;';
      for (let offset = 0; offset < 40; offset++) {
        session.getSemanticScope({
          documentUri: uri,
          documentVersion: 301,
          sql: currentSql,
          cursorOffset: Math.min(offset, currentSql.length),
        });
      }

      expect(session.getCacheSizes()).toEqual({
        parses: 1,
        scopes: 16,
        documents: 1,
      });
      session.invalidateDocument(uri);
      expect(session.getCacheSizes()).toEqual({ parses: 0, scopes: 0, documents: 0 });
    });
  });

  describe('shared extension parse session', () => {
    it('semantic tokens and document links share one parse per document version', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const semantic = new NetezzaSemanticTokensProvider(undefined, undefined, session);
      const links = new NetezzaDocumentLinkProvider(session);
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///shared-session.sql',
      );
      const token = { isCancellationRequested: false } as vscode.CancellationToken;

      try {
        semantic.provideDocumentSemanticTokens(document, token);
        const callsAfterSemantic = spy.mock.calls.length;
        expect(callsAfterSemantic).toBe(1);

        links.provideDocumentLinks(document, token);

        spy.mockClear();
        links.provideDocumentLinks(document, token);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('document outline reuses parse session on same document version', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const provider = new NetezzaDocumentSymbolProvider(session);
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///outline-session-reuse.sql',
      );
      const token = { isCancellationRequested: false } as vscode.CancellationToken;

      try {
        provider.provideDocumentSymbols(document, token);
        expect(spy.mock.calls.length).toBeGreaterThan(0);

        spy.mockClear();
        provider.provideDocumentSymbols(document, token);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('document links', () => {
    it('alias and local-definition filtering share one document-level parse per call', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const scopeSpy = jest.spyOn(parserSqlContext, 'parseSemanticScopeWithParser');
      const session = new DocumentParseSession();
      const provider = new NetezzaDocumentLinkProvider(session);
      const document = createLargeSqlDocument(
        [
          'CREATE TEMP TABLE CTAS_TEST AS SELECT 1 AS id;',
          'SELECT * FROM CTAS_TEST t JOIN JUST_DATA.ADMIN.DIMACCOUNT a ON t.id = a.id;',
        ].join('\n'),
        'file:///document-links-single-parse.sql',
      );

      try {
        const links = provider.provideDocumentLinks(
          document,
          { isCancellationRequested: false } as vscode.CancellationToken,
        );
        expect(links.length).toBeGreaterThan(0);
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        expect(scopeSpy).not.toHaveBeenCalled();

        spy.mockClear();
        provider.provideDocumentLinks(
          document,
          { isCancellationRequested: false } as vscode.CancellationToken,
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        scopeSpy.mockRestore();
      }
    });

    it('repeated document link refresh reuses parse session', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const provider = new NetezzaDocumentLinkProvider(session);
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///document-links-session-reuse.sql',
      );
      const token = { isCancellationRequested: false } as vscode.CancellationToken;

      try {
        provider.provideDocumentLinks(document, token);
        expect(spy.mock.calls.length).toBeGreaterThan(0);

        spy.mockClear();
        for (let i = 0; i < 10; i++) {
          provider.provideDocumentLinks(document, token);
        }
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('session-backed provider does not scale parses with statement/CTE count', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const scopeSpy = jest.spyOn(parserSqlContext, 'parseSemanticScopeWithParser');
      const session = new DocumentParseSession();
      const provider = new NetezzaDocumentLinkProvider(session);
      const statements: string[] = [];
      for (let i = 0; i < 8; i++) {
        statements.push(
          `WITH cte${i} AS (SELECT id FROM JUST_DATA.ADMIN.DIMACCOUNT) ` +
            `SELECT * FROM cte${i};`,
        );
      }
      const document = createLargeSqlDocument(
        statements.join('\n'),
        'file:///document-links-multi-cte.sql',
      );
      const token = { isCancellationRequested: false } as vscode.CancellationToken;

      try {
        provider.provideDocumentLinks(document, token);
        // Without a parse session each CTE-defining statement triggered its own
        // full-document parse (O(statements x parse)). With the session wired in
        // (production: extension.ts), the whole document is parsed once.
        expect(spy.mock.calls.length).toBe(1);
        expect(scopeSpy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        scopeSpy.mockRestore();
      }
    });
  });

  describe('extension hover', () => {
    it('reuses cached full-document parse for symbol resolution', () => {
      const session = new DocumentParseSession();
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const document = createLargeSqlDocument(
        SAMPLE_SQL,
        'file:///hover-session.sql',
      );
      const request = {
        documentUri: document.uri.toString(),
        documentVersion: document.version,
        sql: SAMPLE_SQL,
        databaseKind: 'netezza' as const,
      };
      const offset = SAMPLE_SQL.indexOf('cte') + 1;

      try {
        const parseResult = session.getParseResult(request);
        resolveSqlRenameSymbol(SAMPLE_SQL, offset, 'netezza', parseResult);
        expect(spy.mock.calls.length).toBeGreaterThan(0);

        spy.mockClear();
        const cachedParse = session.getParseResult(request);
        resolveSqlRenameSymbol(SAMPLE_SQL, offset, 'netezza', cachedParse);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('completion statement boundaries', () => {
    it('keys statement lookup by document uri and version', () => {
      const extractor = new CompletionContextExtractor();
      const sqlV1 = 'SELECT 1; SELECT 2;';
      const sqlV2 = 'SELECT 1; SELECT 3;';
      const docV1 = TextDocument.create(
        'file:///completion-version.sql',
        'sql',
        1,
        sqlV1,
      );
      const docV2 = TextDocument.create(
        'file:///completion-version.sql',
        'sql',
        2,
        sqlV2,
      );

      const stmtV1 = extractor.getStatementAtPosition(
        sqlV1,
        sqlV1.indexOf('2'),
        docV1.uri,
        docV1.version,
      );
      expect(stmtV1?.sql.trim()).toBe('SELECT 2');

      const stmtV2 = extractor.getStatementAtPosition(
        sqlV2,
        sqlV2.indexOf('3'),
        docV2.uri,
        docV2.version,
      );
      expect(stmtV2?.sql.trim()).toBe('SELECT 3');
    });

    it('cursor moves on same document version reuse SqlParser boundary cache', () => {
      const extractor = new CompletionContextExtractor();
      const sql = 'SELECT 1; SELECT 2 FROM t; SELECT 3;';
      const uri = 'file:///completion-cursor.sql';
      const version = 1;
      const warmOffset = sql.indexOf('2');

      extractor.getStatementAtPosition(sql, warmOffset, uri, version);

      const tokenizeSpy = jest.spyOn(SqlLexer, 'tokenize');
      try {
        for (let i = 0; i < 100; i++) {
          extractor.getStatementAtPosition(
            sql,
            warmOffset + (i % 20),
            uri,
            version,
          );
        }
        expect(tokenizeSpy).not.toHaveBeenCalled();
      } finally {
        tokenizeSpy.mockRestore();
      }
    });

    it('typing inside the same statement reuses persistent-scope parse', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const session = new DocumentParseSession();
      const extractor = new CompletionContextExtractor(session);
      const prefix = 'SELECT 1 FROM USERS;\nSELECT id FROM ';
      const docV1 = TextDocument.create(
        'file:///completion-stmt-boundary.sql',
        'sql',
        1,
        `${prefix}U`,
      );
      const docV2 = TextDocument.create(
        'file:///completion-stmt-boundary.sql',
        'sql',
        2,
        `${prefix}US`,
      );

      try {
        extractor.getParsedContext(docV1, 'netezza', docV1.getText().length - 1);
        const callsAfterFirst = spy.mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);

        spy.mockClear();
        extractor.getParsedContext(docV2, 'netezza', docV2.getText().length - 1);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('identifier collector', () => {
    it('collectIdentifierOccurrences still parses once for direct callers', () => {
      const spy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      try {
        collectIdentifierOccurrences(SAMPLE_SQL, 'netezza');
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('statement highlight integration', () => {
    it('document version bump invalidates SqlParser boundary cache', () => {
      const documentId = 'file:///version-invalidate.sql';
      const sqlV1 = 'SELECT 1; SELECT 2;';
      const sqlV2 = 'SELECT 1; SELECT 99;';

      SqlParser.clearDocumentCache(documentId);
      SqlParser.getStatementAtPosition(sqlV1, sqlV1.indexOf('2'), {
        documentId,
        version: 1,
      });

      const stmtV2 = SqlParser.getStatementAtPosition(sqlV2, sqlV2.indexOf('99'), {
        documentId,
        version: 2,
      });
      expect(stmtV2?.sql.trim()).toBe('SELECT 99');
    });
  });

  describe('data affordance', () => {
    const mockConnectionManager = {
      getConnectionForExecution: jest.fn().mockReturnValue('CONN1'),
      getActiveConnectionName: jest.fn().mockReturnValue('CONN1'),
      getEffectiveDatabase: jest.fn<() => Promise<string>>().mockResolvedValue('DB1'),
      getExecutionDatabaseKind: jest.fn().mockReturnValue('netezza'),
      getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
    } as unknown as ConnectionManager;

    const mockMetadataCache = {
      getObjectsWithSchema: jest.fn().mockReturnValue([
        {
          schema: 'ADMIN',
          item: { OBJNAME: 'ORDERS', objType: 'TABLE', kind: 6 },
          description: 'Orders table',
        },
      ]),
      getColumns: jest.fn().mockReturnValue([
        { ATTNAME: 'ID', FORMAT_TYPE: 'INT', label: 'ID', detail: 'INT', kind: 5 },
      ]),
      getColumnsAnySchema: jest.fn(),
    } as unknown as MetadataCache;

    const affordanceSql = [
      'WITH cte AS (SELECT id FROM src)',
      'SELECT o.id FROM cte c JOIN DB1.ADMIN.ORDERS o ON c.id = o.id;',
      'SELECT COUNT(*) FROM DB1.ADMIN.ORDERS WHERE status = 1;',
      'SELECT * FROM DB1.ADMIN.ORDERS;',
    ].join('\n');

    it('getReferenceAtPosition performs one parse and avoids parseSemanticScopeWithParser', async () => {
      const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const scopeSpy = jest.spyOn(parserSqlContext, 'parseSemanticScopeWithParser');
      const session = new DocumentParseSession();
      const resolver = new SqlDataAffordanceResolver(
        mockMetadataCache,
        mockConnectionManager,
        session,
      );
      const document = createLargeSqlDocument(
        affordanceSql,
        'file:///affordance-single-parse.sql',
      );
      const ordersOffset = affordanceSql.indexOf('ORDERS');

      try {
        await resolver.getReferenceAtPosition(
          document,
          document.positionAt(ordersOffset),
        );
        expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

        parseSpy.mockClear();
        scopeSpy.mockClear();
        await resolver.getReferenceAtPosition(
          document,
          document.positionAt(ordersOffset + 1),
        );
        expect(parseSpy).not.toHaveBeenCalled();
        expect(scopeSpy).not.toHaveBeenCalled();
      } finally {
        parseSpy.mockRestore();
        scopeSpy.mockRestore();
      }
    });

    it('getResolvedReferences reuses parse session across shadow checks', async () => {
      const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
      const scopeSpy = jest.spyOn(parserSqlContext, 'parseSemanticScopeWithParser');
      const session = new DocumentParseSession();
      const resolver = new SqlDataAffordanceResolver(
        mockMetadataCache,
        mockConnectionManager,
        session,
      );
      const document = createLargeSqlDocument(
        affordanceSql,
        'file:///affordance-full-resolve.sql',
      );

      try {
        const references = await resolver.getResolvedReferences(document);
        expect(references.length).toBeGreaterThan(0);
        expect(parseSpy.mock.calls.length).toBeGreaterThan(0);
        expect(scopeSpy).not.toHaveBeenCalled();

        parseSpy.mockClear();
        await resolver.getResolvedReferences(document);
        expect(parseSpy).not.toHaveBeenCalled();
      } finally {
        parseSpy.mockRestore();
        scopeSpy.mockRestore();
      }
    });
  });
});
