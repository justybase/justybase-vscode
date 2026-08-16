/**
 * LSP Feature Performance Benchmark
 *
 * End-to-end timing for completion, hover, inlay hint, and diagnostics engines
 * with synthetic SQL documents and mock metadata.
 *
 * Run: npm run benchmark:lsp
 * Enforce budgets: LSP_BENCHMARK_ENFORCE=1 npm run benchmark:lsp
 */

import { execSync } from "child_process";
import { performance } from "perf_hooks";
import * as fs from "fs";
import * as path from "path";
import {
  CompletionTriggerKind,
  Position,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { generateBenchmarkDocuments } from "./sqlGenerator";
import { getDatabaseSqlAuthoring } from "../src/core/connectionFactory";
import { LspCompletionEngine } from "../src/server/completionEngine";
import { LspInlayHintEngine } from "../src/server/inlayHintEngine";
import type { CompletionMetadataProvider } from "../src/server/completionTypes";
import type { MetadataBridge } from "../src/server/metadataBridge";
import type { MetadataColumnItem, MetadataObjectItem } from "../src/lsp/protocol";
import { provideHover, type HoverDependencies } from "../src/server/hoverEngine";
import { toDocumentParseRequest } from "../src/server/documentParseRequest";
import {
  DocumentParseSession,
  DocumentValidationSession,
  resolveSqlRenameSymbolWithSession,
  SqlValidator,
  type ValidationError,
} from "../src/sqlParser";
import * as parsingRuntime from "../src/sqlParser/parsingRuntime";
import { SqlParser } from "../src/sql/sqlParser";

const ITERATIONS = 8;
const WARMUP = 2;

const BUDGETS_MS = {
  completionMedian: 150,
  completionP95: 300,
  hoverMedian: 150,
  hoverP95: 300,
  definitionMedian: 150,
  definitionP95: 300,
  referencesMedian: 150,
  referencesP95: 300,
  inlayMedian: 600,
  inlayP95: 1200,
  diagnosticsMedian: 500,
  diagnosticsP95: 1000,
};

/** Relaxed tier for 3000-line diagnostics until incremental validation lands. */
const XLARGE_BUDGETS_MS = {
  diagnosticsMedian: 800,
  diagnosticsP95: 850,
  inlayMedian: 1800,
  inlayP95: 1900,
};

/** Enforce latency budgets locally; CI only records results (shared runners vary). */
const ENFORCE_LSP_BUDGETS = process.env.LSP_BENCHMARK_ENFORCE === "1";

type BenchmarkStage =
  | "completion"
  | "hover"
  | "definition"
  | "references"
  | "inlay"
  | "diagnostics";

interface BenchmarkResultRow {
  stage: BenchmarkStage;
  doc: string;
  medianMs: number;
  p95Ms: number;
  parseCalls?: number;
  validatedStatements?: number;
}

class BenchmarkMetadataProvider implements CompletionMetadataProvider {
  readonly getContext = async () => ({
    effectiveDatabase: "JUST_DATA",
    effectiveSchema: "ADMIN",
    databaseKind: "netezza" as const,
  });

  readonly getDatabases = async (): Promise<MetadataObjectItem[]> => [
    { name: "JUST_DATA", detail: "Database" },
  ];

  readonly getSchemas = async (): Promise<MetadataObjectItem[]> => [
    { name: "ADMIN", detail: "Schema" },
  ];

  readonly getTables = async (): Promise<MetadataObjectItem[]> =>
    Array.from({ length: 200 }, (_, index) => ({
      name: `TABLE_${index}`,
      detail: "Table",
    }));

  readonly getViews = async (): Promise<MetadataObjectItem[]> => [];

  readonly getProcedures = async (): Promise<MetadataObjectItem[]> =>
    Array.from({ length: 50 }, (_, index) => ({
      name: `PROC_${index}`,
      detail: `PROC_${index}(INTEGER, VARCHAR)`,
    }));

  readonly getColumns = async (): Promise<MetadataColumnItem[]> =>
    Array.from({ length: 80 }, (_, index) => ({
      name: `COL_${index}`,
      type: "INTEGER",
    }));

  readonly getTableInfo = async () => null;

  readonly getCachedTableInfo = async () => undefined;
}

async function benchmarkAsync(
  fn: () => Promise<void> | void,
): Promise<{ medianMs: number; p95Ms: number }> {
  for (let i = 0; i < WARMUP; i++) {
    await fn();
  }

  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
  };
}

function isXLargeDocument(documentName: string): boolean {
  return documentName.includes("3000") && !documentName.includes("incremental");
}

function getBudgetLimits(
  stage: BenchmarkStage,
  documentName: string,
): {
  median: number;
  p95: number;
  tier: "standard" | "xlarge";
} {
  if (
    (stage === "diagnostics" || stage === "inlay") &&
    isXLargeDocument(documentName)
  ) {
    return {
      median:
        stage === "diagnostics"
          ? XLARGE_BUDGETS_MS.diagnosticsMedian
          : XLARGE_BUDGETS_MS.inlayMedian,
      p95:
        stage === "diagnostics"
          ? XLARGE_BUDGETS_MS.diagnosticsP95
          : XLARGE_BUDGETS_MS.inlayP95,
      tier: "xlarge",
    };
  }

  switch (stage) {
    case "completion":
      return {
        median: BUDGETS_MS.completionMedian,
        p95: BUDGETS_MS.completionP95,
        tier: "standard",
      };
    case "hover":
      return {
        median: BUDGETS_MS.hoverMedian,
        p95: BUDGETS_MS.hoverP95,
        tier: "standard",
      };
    case "definition":
      return {
        median: BUDGETS_MS.definitionMedian,
        p95: BUDGETS_MS.definitionP95,
        tier: "standard",
      };
    case "references":
      return {
        median: BUDGETS_MS.referencesMedian,
        p95: BUDGETS_MS.referencesP95,
        tier: "standard",
      };
    case "inlay":
      return {
        median: BUDGETS_MS.inlayMedian,
        p95: BUDGETS_MS.inlayP95,
        tier: "standard",
      };
    case "diagnostics":
      return {
        median: BUDGETS_MS.diagnosticsMedian,
        p95: BUDGETS_MS.diagnosticsP95,
        tier: "standard",
      };
  }
}

function getBudgetStatus(
  stage: BenchmarkStage,
  documentName: string,
  medianMs: number,
  p95Ms: number,
): "PASS" | "FAIL" {
  const limits = getBudgetLimits(stage, documentName);
  return medianMs <= limits.median && p95Ms <= limits.p95 ? "PASS" : "FAIL";
}

function tryGetGitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function enforceBudget(
  stage: BenchmarkStage,
  documentName: string,
  timing: { medianMs: number; p95Ms: number },
): void {
  if (!ENFORCE_LSP_BUDGETS) {
    return;
  }

  const limits = getBudgetLimits(stage, documentName);
  expect(timing.medianMs).toBeLessThanOrEqual(limits.median);
  expect(timing.p95Ms).toBeLessThanOrEqual(limits.p95);
}

async function benchmarkIncrementalDiagnostics(
  validator: SqlValidator,
  parseSession: DocumentParseSession,
  validationProfile: ReturnType<typeof getDatabaseSqlAuthoring>["validation"],
  sql: string,
): Promise<{
  timing: { medianMs: number; p95Ms: number };
  validatedStatements: number;
}> {
  const uri = "benchmark://incremental-diagnostics.sql";
  const validationSession = new DocumentValidationSession();
  const baseState = validationSession.prepareDocument(uri, sql);
  for (const statement of baseState.nextIndex.statements) {
    validationSession.storeStatementDiagnostics(uri, statement, []);
  }
  validationSession.commitDocumentIndex(uri, baseState.nextIndex);

  const targetStatement =
    baseState.nextIndex.statements[
      Math.floor(baseState.nextIndex.statements.length / 2)
    ];
  const editedSql = targetStatement
    ? `${sql.slice(0, targetStatement.endOffset)} /* incremental */${sql.slice(targetStatement.endOffset)}`
    : `${sql}\nSELECT 1;`;
  const nextState = validationSession.prepareDocument(uri, editedSql);
  const dirtyIndices = nextState.diff.dirtyIndices;
  const cachedDiagnostics = new Map<number, ValidationError[]>();
  for (const statement of nextState.nextIndex.statements) {
    if (dirtyIndices.includes(statement.index)) {
      continue;
    }
    const cached = validationSession.getCachedDiagnostics(uri, statement);
    if (cached) {
      cachedDiagnostics.set(statement.index, cached);
    }
  }

  const timing = await benchmarkAsync(async () => {
    parseSession.clear();
    void validationProfile;
    validator.validateIncrementalFromStatements(
      editedSql,
      nextState.nextIndex.statements,
      dirtyIndices,
      cachedDiagnostics,
    );
  });

  return {
    timing,
    validatedStatements: dirtyIndices.length,
  };
}

describe("LSP Feature Performance Benchmark", () => {
  const docs = generateBenchmarkDocuments().filter(
    (doc) =>
      doc.name.includes("500") ||
      doc.name.includes("1000") ||
      doc.name.includes("3000"),
  );
  const metadata = new BenchmarkMetadataProvider();
  const documentParseSession = new DocumentParseSession();
  const completionEngine = new LspCompletionEngine(
    metadata,
    documentParseSession,
  );
  const inlayEngine = new LspInlayHintEngine(metadata, documentParseSession);
  const validationProfile = getDatabaseSqlAuthoring("netezza").validation;
  const diagnosticsValidator = new SqlValidator(undefined, validationProfile);

  const hoverDeps: HoverDependencies = {
    resolveSqlRenameSymbol: (_sql, offset, databaseKind) =>
      resolveSqlRenameSymbolWithSession(
        documentParseSession,
        toDocumentParseRequest(
          { uri: "benchmark://hover.sql", version: 1 },
          _sql,
          databaseKind,
        ),
        offset,
      ),
    getStatementAtPosition: (sql, offset) =>
      SqlParser.getStatementAtPosition(sql, offset),
    getAliasBindings: (statementSql, statementOffset, databaseKind) =>
      documentParseSession.getSemanticScope({
        ...toDocumentParseRequest(
          { uri: "benchmark://hover.sql", version: 1 },
          statementSql,
          databaseKind,
        ),
        cursorOffset: statementOffset,
      }).preferredAliasBindings,
    getCompletionLocalDefinitions: () => [],
    findLocalDefinition: () => undefined,
    formatObjectPath: (db, schema, table) =>
      [db, schema, table].filter(Boolean).join("."),
    isCancellationRequested: () => false,
  };

  const results: BenchmarkResultRow[] = [];

  for (const doc of docs) {
    const textDocument = TextDocument.create(
      `benchmark://${doc.name}.sql`,
      "sql",
      1,
      doc.sql,
    );
    const position = Position.create(
      Math.max(0, doc.actualLines - 2),
      10,
    );

    it(`completion ${doc.name}`, async () => {
      const timing = await benchmarkAsync(async () => {
        await completionEngine.provideCompletionItems(
          textDocument,
          position,
          CompletionTriggerKind.Invoked,
        );
      });
      results.push({
        stage: "completion",
        doc: doc.name,
        ...timing,
      });
      enforceBudget("completion", doc.name, timing);
    });

    it(`hover ${doc.name}`, async () => {
      const timing = await benchmarkAsync(async () => {
        await provideHover(
          textDocument,
          { position },
          hoverDeps,
          metadata as unknown as MetadataBridge,
        );
      });
      results.push({
        stage: "hover",
        doc: doc.name,
        ...timing,
      });
      enforceBudget("hover", doc.name, timing);
    });

    it(`definition ${doc.name}`, async () => {
      const timing = await benchmarkAsync(() => {
        const symbol = resolveSqlRenameSymbolWithSession(
          documentParseSession,
          toDocumentParseRequest(textDocument, doc.sql, "netezza"),
          textDocument.offsetAt(position),
        );
        void (
          symbol?.occurrences.find((occurrence) => occurrence.role === "definition") ??
          symbol?.target
        );
      });
      results.push({
        stage: "definition",
        doc: doc.name,
        ...timing,
      });
      enforceBudget("definition", doc.name, timing);
    });

    it(`references ${doc.name}`, async () => {
      const timing = await benchmarkAsync(() => {
        const symbol = resolveSqlRenameSymbolWithSession(
          documentParseSession,
          toDocumentParseRequest(textDocument, doc.sql, "netezza"),
          textDocument.offsetAt(position),
        );
        void symbol?.occurrences;
      });
      results.push({
        stage: "references",
        doc: doc.name,
        ...timing,
      });
      enforceBudget("references", doc.name, timing);
    });

    it(`inlay ${doc.name}`, async () => {
      const timing = await benchmarkAsync(async () => {
        await inlayEngine.provideInlayHints(textDocument, {
          start: Position.create(0, 0),
          end: Position.create(textDocument.lineCount, 0),
        });
      });
      results.push({
        stage: "inlay",
        doc: doc.name,
        ...timing,
      });
      enforceBudget("inlay", doc.name, timing);
    });

    it(`diagnostics ${doc.name}`, async () => {
      const timing = await benchmarkAsync(() => {
        diagnosticsValidator.validate(doc.sql);
      });
      results.push({
        stage: "diagnostics",
        doc: doc.name,
        ...timing,
      });
      enforceBudget("diagnostics", doc.name, timing);
    });
  }

  it("incremental diagnostics edit XLarge (3000 lines)", async () => {
    const xlargeDoc = docs.find((doc) => doc.name.includes("3000"));
    if (!xlargeDoc) {
      return;
    }

    const { timing, validatedStatements } =
      await benchmarkIncrementalDiagnostics(
        diagnosticsValidator,
        documentParseSession,
        validationProfile,
        xlargeDoc.sql,
      );

    results.push({
      stage: "diagnostics",
      doc: `${xlargeDoc.name}-incremental-edit`,
      ...timing,
      validatedStatements,
    });
    enforceBudget("diagnostics", `${xlargeDoc.name}-incremental-edit`, timing);
    expect(validatedStatements).toBeGreaterThan(0);
    expect(validatedStatements).toBeLessThanOrEqual(2);
  });

  it("definition and references share parse on xlarge", async () => {
    const xlargeDoc = docs.find((doc) => doc.name.includes("3000"));
    if (!xlargeDoc) {
      return;
    }

    const textDocument = TextDocument.create(
      `benchmark://${xlargeDoc.name}-symbols.sql`,
      "sql",
      1,
      xlargeDoc.sql,
    );
    const position = Position.create(
      Math.max(0, xlargeDoc.actualLines - 2),
      10,
    );
    const offset = textDocument.offsetAt(position);
    const parseRequest = toDocumentParseRequest(textDocument, xlargeDoc.sql, "netezza");
    const parseSpy = jest.spyOn(parsingRuntime, "parseSqlStatements");
    documentParseSession.clear();

    resolveSqlRenameSymbolWithSession(documentParseSession, parseRequest, offset);
    resolveSqlRenameSymbolWithSession(documentParseSession, parseRequest, offset + 1);

    const parseCalls = parseSpy.mock.calls.length;
    parseSpy.mockRestore();

    results.push({
      stage: "definition",
      doc: `${xlargeDoc.name}-symbol-parse-dedup`,
      medianMs: 0,
      p95Ms: 0,
      parseCalls,
    });

    expect(parseCalls).toBe(1);
  });

  it("multi-feature same doc reports single parse on xlarge", async () => {
    const xlargeDoc = docs.find((doc) => doc.name.includes("3000"));
    if (!xlargeDoc) {
      return;
    }

    const textDocument = TextDocument.create(
      `benchmark://${xlargeDoc.name}-multi.sql`,
      "sql",
      1,
      xlargeDoc.sql,
    );
    const position = Position.create(
      Math.max(0, xlargeDoc.actualLines - 2),
      10,
    );
    const parseSpy = jest.spyOn(parsingRuntime, "parseSqlStatements");
    documentParseSession.clear();

    diagnosticsValidator.validateWithSession(
      xlargeDoc.sql,
      documentParseSession,
      {
        documentUri: textDocument.uri,
        documentVersion: textDocument.version,
        sql: xlargeDoc.sql,
        databaseKind: "netezza",
        validationProfile,
      },
    );
    await completionEngine.provideCompletionItems(
      textDocument,
      position,
      CompletionTriggerKind.Invoked,
    );
    await inlayEngine.provideInlayHints(textDocument, {
      start: Position.create(0, 0),
      end: Position.create(textDocument.lineCount, 0),
    });

    const parseCalls = parseSpy.mock.calls.length;
    const fullDocumentParseCalls = parseSpy.mock.calls.filter(
      (call) => call[0]?.sql === xlargeDoc.sql,
    ).length;
    parseSpy.mockRestore();

    results.push({
      stage: "diagnostics",
      doc: `${xlargeDoc.name}-multi-feature`,
      medianMs: 0,
      p95Ms: 0,
      parseCalls,
    });

    expect(parseCalls).toBeGreaterThan(0);
    expect(fullDocumentParseCalls).toBeLessThanOrEqual(1);
  });

  afterAll(() => {
    const commit = tryGetGitCommit();
    const baselineRows = results.map((row) => ({
      ...row,
      budget: getBudgetStatus(row.stage, row.doc, row.medianMs, row.p95Ms),
      tier: getBudgetLimits(row.stage, row.doc).tier,
    }));

    const lines = [
      "# LSP Feature Benchmark Results",
      "",
      `Commit: ${commit}`,
      "",
      "| Stage | Document | Median (ms) | P95 (ms) | Parse calls | Validated statements |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      ...results.map(
        (row) =>
          `| ${row.stage} | ${row.doc} | ${row.medianMs.toFixed(2)} | ${row.p95Ms.toFixed(2)} | ${row.parseCalls ?? "—"} | ${row.validatedStatements ?? "—"} |`,
      ),
      "",
      "## Baseline",
      "",
      `Recorded: (${commit})`,
      "",
      "| Stage | Document | Median (ms) | P95 (ms) | Tier | Budget |",
      "| --- | --- | ---: | ---: | :---: | :---: |",
      ...baselineRows.map(
        (row) =>
          `| ${row.stage} | ${row.doc} | ${row.medianMs.toFixed(2)} | ${row.p95Ms.toFixed(2)} | ${row.tier} | ${row.budget} |`,
      ),
      "",
      "## Budgets",
      "",
      `- completion median ≤ ${BUDGETS_MS.completionMedian}ms, p95 ≤ ${BUDGETS_MS.completionP95}ms`,
      `- hover median ≤ ${BUDGETS_MS.hoverMedian}ms, p95 ≤ ${BUDGETS_MS.hoverP95}ms`,
      `- definition median ≤ ${BUDGETS_MS.definitionMedian}ms, p95 ≤ ${BUDGETS_MS.definitionP95}ms`,
      `- references median ≤ ${BUDGETS_MS.referencesMedian}ms, p95 ≤ ${BUDGETS_MS.referencesP95}ms`,
      `- inlay median ≤ ${BUDGETS_MS.inlayMedian}ms, p95 ≤ ${BUDGETS_MS.inlayP95}ms`,
      `- diagnostics median ≤ ${BUDGETS_MS.diagnosticsMedian}ms, p95 ≤ ${BUDGETS_MS.diagnosticsP95}ms`,
      `- inlay xlarge (3000 lines) median ≤ ${XLARGE_BUDGETS_MS.inlayMedian}ms, p95 ≤ ${XLARGE_BUDGETS_MS.inlayP95}ms`,
      `- diagnostics xlarge (3000 lines) median ≤ ${XLARGE_BUDGETS_MS.diagnosticsMedian}ms, p95 ≤ ${XLARGE_BUDGETS_MS.diagnosticsP95}ms`,
      `- multi-feature xlarge full-document parseCalls ≤ 1 (diagnostics + completion + inlay share DocumentParseSession)`,
      `- definition/references xlarge symbol-parse-dedup parseCalls = 1`,
      "",
      `Budget enforcement: ${ENFORCE_LSP_BUDGETS ? "on (LSP_BENCHMARK_ENFORCE=1)" : "off (report only)"}`,
    ];
    const outputPath = path.join(__dirname, "lspFeature.results.md");
    fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
  });
});
