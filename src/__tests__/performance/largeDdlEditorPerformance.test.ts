/**
 * Large DDL editor-provider performance regression tests.
 *
 * Simulates synchronous extension-host work triggered when opening or switching
 * to a large DDL dump. Uses committed perf_ddl_heavy.sql (~1 MB) and, when
 * available locally, JD_DDL.sql (~211 KB) with tighter budgets.
 *
 * Run with:
 *   JEST_SILENT=0 npx jest src/__tests__/performance/largeDdlEditorPerformance.test.ts --runInBand
 */

import { jest } from '@jest/globals';
import { performance } from 'perf_hooks';

jest.unmock('chevrotain');
jest.mock('vscode', () => jest.requireActual('../__mocks__/vscode'));

import * as vscode from 'vscode';
import { updateSqlHighlight } from '../../editors/decorationManager';
import { DocumentParseSession } from '../../sqlParser/documentParseSession';
import { NetezzaDocumentLinkProvider } from '../../providers/documentLinkProvider';
import { NetezzaDocumentSymbolProvider } from '../../providers/documentSymbolProvider';
import { NetezzaFoldingRangeProvider } from '../../providers/foldingProvider';
import { SqlCodeLensProvider } from '../../providers/sqlCodeLensProvider';
import { NetezzaSemanticTokensProvider } from '../../providers/semanticTokensProvider';
import { SqlQualityEngine } from '../../providers/sqlQualityEngine';
import { SqlValidator } from '../../sqlParser';
import * as parsingRuntime from '../../sqlParser/parsingRuntime';
import { SqlLexer } from '../../sqlParser/lexer';
import { SqlParser } from '../../sql/sqlParser';
import {
  benchmarkSync,
  createLargeSqlDocument,
  loadDdlFixture,
  tryLoadJdDdlFixture,
  type DdlFixture,
} from './largeDdlTestHelpers';

class MockDocumentLink {
  public tooltip?: string;
  constructor(
    public range: vscode.Range,
    public target?: vscode.Uri,
  ) {}
}

class MockFoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: unknown,
  ) {}
}

class MockDocumentSymbol {
  public children: MockDocumentSymbol[] = [];
  constructor(
    public name: string,
    public detail: string,
    public kind: unknown,
    public range: vscode.Range,
    public selectionRange: vscode.Range,
  ) {}
}

const BUDGETS = {
  jdDdl: {
    documentLinksMs: 500,
    semanticTokensMs: 500,
    documentSymbolsMs: 400,
    codeLensesMs: 300,
    foldingMs: 50,
    statementHighlightMs: 100,
    statementHighlightCacheReuseMs: 20,
    statementHighlightEndToEndMs: 40,
    qualityRulesOnlyMs: 800,
    tabSwitchTotalMs: 2_000,
  },
  heavyDdl: {
    documentLinksMs: 2_500,
    semanticTokensMs: 2_000,
    documentSymbolsMs: 1_500,
    codeLensesMs: 1_000,
    foldingMs: 200,
    statementHighlightMs: 400,
    statementHighlightCacheReuseMs: 50,
    statementHighlightEndToEndMs: 150,
    qualityRulesOnlyMs: 3_000,
    tabSwitchTotalMs: 6_000,
  },
} as const;

function patchVscodeConstructors(): void {
  (vscode as unknown as { DocumentLink: typeof MockDocumentLink }).DocumentLink =
    MockDocumentLink;
  (vscode as unknown as { FoldingRange: typeof MockFoldingRange }).FoldingRange =
    MockFoldingRange;
  (vscode as unknown as { FoldingRangeKind: { Region: string } }).FoldingRangeKind =
    { Region: 'region' };
  (vscode as unknown as { DocumentSymbol: typeof MockDocumentSymbol }).DocumentSymbol =
    MockDocumentSymbol;
  (vscode as unknown as { SymbolKind: Record<string, number> }).SymbolKind = {
    Struct: 1,
    Variable: 2,
    Class: 3,
    Object: 4,
    Field: 5,
  };
  (vscode.Uri as unknown as { parse: (value: string) => vscode.Uri }).parse =
    jest.fn((value: string) => ({
      toString: () => value,
      fsPath: value,
    })) as unknown as typeof vscode.Uri.parse;
}

function runTabSwitchSimulation(
  document: vscode.TextDocument,
  providers: {
    folding: NetezzaFoldingRangeProvider;
    links: NetezzaDocumentLinkProvider;
    symbols: NetezzaDocumentSymbolProvider;
    lenses: SqlCodeLensProvider;
    semantic: NetezzaSemanticTokensProvider;
  },
): number {
  const token = { isCancellationRequested: false } as vscode.CancellationToken;
  const t0 = performance.now();
  providers.folding.provideFoldingRanges(
    document,
    {} as vscode.FoldingContext,
    token,
  );
  providers.links.provideDocumentLinks(document, token);
  providers.symbols.provideDocumentSymbols(document, token);
  providers.lenses.provideCodeLenses(document, token);
  providers.semantic.provideDocumentSemanticTokens(document, token);
  return performance.now() - t0;
}

function createHighlightEditor(
  document: vscode.TextDocument,
  offset: number,
): vscode.TextEditor {
  return {
    document,
    selection: new vscode.Selection(
      document.positionAt(offset),
      document.positionAt(offset),
    ),
    setDecorations: jest.fn(),
  } as unknown as vscode.TextEditor;
}

function registerProviderBudgetTests(
  fixture: DdlFixture,
  budgets: (typeof BUDGETS)[keyof typeof BUDGETS],
): void {
  const document = createLargeSqlDocument(fixture.sql, `file:///${fixture.label}`);
  const folding = new NetezzaFoldingRangeProvider();
  const links = new NetezzaDocumentLinkProvider(new DocumentParseSession());
  const symbols = new NetezzaDocumentSymbolProvider();
  const lenses = new SqlCodeLensProvider();
  const semantic = new NetezzaSemanticTokensProvider(
    undefined,
    undefined,
    new DocumentParseSession(),
  );
  const qualityEngine = new SqlQualityEngine(new SqlValidator());
  const providers = { folding, links, symbols, lenses, semantic };

  it(`document links stay within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(() => {
      const result = links.provideDocumentLinks(
        document,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      expect(result.length).toBeGreaterThan(0);
    });
    expect(maxMs).toBeLessThan(budgets.documentLinksMs);
  });

  it(`document links perform one parse per invocation (${fixture.label})`, () => {
    const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
    const session = new DocumentParseSession();
    const wiredLinks = new NetezzaDocumentLinkProvider(session);

    try {
      wiredLinks.provideDocumentLinks(
        document,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      expect(parseSpy).toHaveBeenCalledTimes(1);

      parseSpy.mockClear();
      wiredLinks.provideDocumentLinks(
        document,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
  });

  it(`semantic tokens stay within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(() => {
      const tokens = semantic.provideDocumentSemanticTokens(
        document,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      expect(tokens.data.length).toBeGreaterThan(0);
    });
    expect(maxMs).toBeLessThan(budgets.semanticTokensMs);
  });

  it(`document symbols stay within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(() => {
      const result = symbols.provideDocumentSymbols(
        document,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      expect(result).toBeDefined();
    });
    expect(maxMs).toBeLessThan(budgets.documentSymbolsMs);
  });

  it(`code lenses stay within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(() => {
      const result = lenses.provideCodeLenses(
        document,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
      expect(Array.isArray(result)).toBe(true);
      expect((result as vscode.CodeLens[]).length).toBeGreaterThan(0);
    });
    expect(maxMs).toBeLessThan(budgets.codeLensesMs);
  });

  it(`folding ranges stay within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(() => {
      folding.provideFoldingRanges(
        document,
        {} as vscode.FoldingContext,
        { isCancellationRequested: false } as vscode.CancellationToken,
      );
    });
    expect(maxMs).toBeLessThan(budgets.foldingMs);
  });

  it(`statement highlight stays within budget (${fixture.label})`, () => {
    const offset = Math.floor(fixture.charCount / 2);
    const editor = {
      document,
      selection: new vscode.Selection(
        document.positionAt(offset),
        document.positionAt(offset),
      ),
      setDecorations: jest.fn(),
    } as unknown as vscode.TextEditor;
    const decorationType = {} as vscode.TextEditorDecorationType;

    const { maxMs } = benchmarkSync(() => {
      updateSqlHighlight(decorationType, editor);
    });
    expect(maxMs).toBeLessThan(budgets.statementHighlightMs);
    expect(SqlParser.getStatementAtPosition(fixture.sql, offset)).not.toBeNull();
  });

  it(`repeated cursor moves reuse statement cache (${fixture.label})`, () => {
    const baseOffset = Math.floor(fixture.charCount / 2);
    const documentKey = {
      documentId: `file:///${fixture.label}`,
      version: 1,
    };

    SqlParser.clearDocumentCache(documentKey.documentId);
    SqlParser.getStatementAtPosition(fixture.sql, baseOffset, documentKey);

    const { maxMs } = benchmarkSync(() => {
      for (let i = 0; i < 100; i++) {
        SqlParser.getStatementAtPosition(
          fixture.sql,
          baseOffset + (i % 50),
          documentKey,
        );
      }
    });

    expect(maxMs).toBeLessThan(budgets.statementHighlightCacheReuseMs);
  });

  it(`cached statement lookup does not re-tokenize (${fixture.label})`, () => {
    const baseOffset = Math.floor(fixture.charCount / 2);
    const documentKey = {
      documentId: `file:///${fixture.label}`,
      version: 1,
    };

    SqlParser.clearDocumentCache(documentKey.documentId);
    const tokenizeSpy = jest.spyOn(SqlLexer, 'tokenize');

    try {
      SqlParser.getStatementAtPosition(fixture.sql, baseOffset, documentKey);
      const tokenizeCountAfterWarmup = tokenizeSpy.mock.calls.length;
      expect(tokenizeCountAfterWarmup).toBeGreaterThan(0);

      for (let i = 0; i < 100; i++) {
        SqlParser.getStatementAtPosition(
          fixture.sql,
          baseOffset + (i % 50),
          documentKey,
        );
      }

      expect(tokenizeSpy.mock.calls.length).toBe(tokenizeCountAfterWarmup);
    } finally {
      tokenizeSpy.mockRestore();
    }
  });

  it(`repeated updateSqlHighlight reuses cache after warm-up (${fixture.label})`, () => {
    const decorationType = {} as vscode.TextEditorDecorationType;
    const baseOffset = Math.floor(fixture.charCount / 2);
    const documentKey = {
      documentId: `file:///${fixture.label}`,
      version: 1,
    };

    SqlParser.clearDocumentCache(documentKey.documentId);
    updateSqlHighlight(decorationType, createHighlightEditor(document, baseOffset));

    const tokenizeSpy = jest.spyOn(SqlLexer, 'tokenize');
    try {
      const { maxMs } = benchmarkSync(() => {
        for (let i = 0; i < 100; i++) {
          const offset = baseOffset + (i % 50);
          updateSqlHighlight(
            decorationType,
            createHighlightEditor(document, offset),
          );
        }
      });

      expect(maxMs).toBeLessThan(budgets.statementHighlightEndToEndMs);
      expect(tokenizeSpy).not.toHaveBeenCalled();
      expect(
        SqlParser.getStatementAtPosition(fixture.sql, baseOffset, documentKey),
      ).not.toBeNull();
    } finally {
      tokenizeSpy.mockRestore();
    }
  });

  it(`quality-only lint stays within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(() => {
      const result = qualityEngine.analyzeQualityRulesOnly(fixture.sql);
      expect(Array.isArray(result.issues)).toBe(true);
    });
    expect(maxMs).toBeLessThan(budgets.qualityRulesOnlyMs);
  });

  it(`tab-switch provider bundle stays within budget (${fixture.label})`, () => {
    const { maxMs } = benchmarkSync(
      () => {
        const elapsed = runTabSwitchSimulation(document, providers);
        expect(elapsed).toBeGreaterThan(0);
      },
      2,
      0,
    );
    expect(maxMs).toBeLessThan(budgets.tabSwitchTotalMs);
  });
}

describe('Large DDL editor performance', () => {
  beforeAll(() => {
    patchVscodeConstructors();
  });

  describe('perf_ddl_heavy.sql (committed stress fixture)', () => {
    const fixture = loadDdlFixture('perf_ddl_heavy.sql');

    beforeAll(() => {
      console.log(
        `  Loaded ${fixture.label}: ${fixture.lineCount} lines, ${(fixture.charCount / 1024).toFixed(0)} KB`,
      );
    });

    registerProviderBudgetTests(fixture, BUDGETS.heavyDdl);
  });

  const jdFixture = tryLoadJdDdlFixture();
  if (jdFixture) {
    describe('JD_DDL.sql (user regression fixture)', () => {
      beforeAll(() => {
        console.log(
          `  Loaded ${jdFixture.label}: ${jdFixture.lineCount} lines, ${(jdFixture.charCount / 1024).toFixed(0)} KB`,
        );
      });

      registerProviderBudgetTests(jdFixture, BUDGETS.jdDdl);
    });
  } else {
    it('skips JD_DDL.sql budgets when fixture is unavailable locally', () => {
      expect(jdFixture).toBeUndefined();
    });
  }
});
