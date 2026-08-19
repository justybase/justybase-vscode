/**
 * Incremental validation benchmark for editor typing.
 *
 * Run with: npm run benchmark:typing
 * Disable hard latency assertions temporarily with TYPING_BENCHMARK_ENFORCE=0.
 */

import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { generateBenchmarkDocuments, type BenchmarkDocument } from "./sqlGenerator";
import {
  DocumentParseSession,
  DocumentValidationSession,
  SqlValidator,
  type SchemaProvider,
  type TableInfo,
  type ValidationError,
} from "../src/sqlParser";
import { getDatabaseSqlAuthoring } from "../src/core/connectionFactory";

const WARMUP_EDITS = 32;
const MEASURED_EDITS = 32;
const MAX_SQL_LINES = new Set([500, 1000, 3000]);
const ENFORCE_BUDGETS = process.env.TYPING_BENCHMARK_ENFORCE !== "0";

interface TimingStats {
  medianMs: number;
  p95Ms: number;
}

interface TypingResult {
  document: string;
  actualLines: number;
  iterations: number;
  timing: TimingStats;
  baseline: TimingStats;
  fullDocumentParses: number;
  validatedStatements: number[];
  metadataReferences: number;
}

class CountingSchemaProvider implements SchemaProvider {
  private references = 0;

  getTable(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): TableInfo {
    this.references++;
    return {
      database,
      schema,
      name: tableName,
      isCte: false,
      isTempTable: false,
      columns: [
        { name: "ID", dataType: "INTEGER" },
        { name: "CUSTOMER_ID", dataType: "INTEGER" },
        { name: "ORDER_ID", dataType: "INTEGER" },
        { name: "NAME", dataType: "VARCHAR" },
        { name: "CREATED_DATE", dataType: "DATE" },
      ],
    };
  }

  tableExists(
    database: string | undefined,
    schema: string | undefined,
    tableName: string,
  ): boolean {
    void database;
    void schema;
    void tableName;
    this.references++;
    return true;
  }

  canValidateUnqualifiedTableReferences(): boolean {
    return true;
  }

  takeReferenceCount(): number {
    const count = this.references;
    this.references = 0;
    return count;
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

function getStats(values: number[]): TimingStats {
  return {
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function getDiagnostics(result: {
  errors: ValidationError[];
  warnings: ValidationError[];
}): ValidationError[] {
  return [...result.errors, ...result.warnings];
}

function diagnosticsForStatement(
  diagnostics: ValidationError[],
  statement: { startOffset: number; endOffset: number },
): ValidationError[] {
  return diagnostics.filter((diagnostic) => {
    const offset = diagnostic.position.offset ?? -1;
    return offset >= statement.startOffset && offset <= statement.endOffset;
  });
}

function collectCachedDiagnostics(
  validationSession: DocumentValidationSession,
  documentUri: string,
  statements: readonly { index: number; startOffset: number; endOffset: number; contentHash: string }[],
  dirtyIndices: readonly number[],
): Map<number, ValidationError[]> {
  const dirty = new Set(dirtyIndices);
  const cached = new Map<number, ValidationError[]>();
  for (const statement of statements) {
    if (dirty.has(statement.index)) {
      continue;
    }
    const diagnostics = validationSession.getCachedDiagnostics(documentUri, statement);
    if (diagnostics) {
      cached.set(statement.index, diagnostics);
    }
  }
  return cached;
}

function assertChangeHandlerDoesNotValidateSynchronously(): void {
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/server/main.ts"), "utf8");
  const changeHandler = /documents\.onDidChangeContent\(\(event\) => \{([\s\S]*?)\}\);/.exec(mainSource)?.[1] ?? "";
  expect(changeHandler).toContain("scheduleDiagnostics");
  expect(changeHandler).not.toMatch(/validate|runValidationPipeline|publishDiagnostics/);
}

function runTypingScenario(doc: BenchmarkDocument): TypingResult {
  const uri = `benchmark://typing/${doc.targetLines}.sql`;
  const validationProfile = getDatabaseSqlAuthoring("netezza").validation;
  const schemaProvider = new CountingSchemaProvider();
  const validator = new SqlValidator(schemaProvider, validationProfile);
  const parseSession = new DocumentParseSession();
  const validationSession = new DocumentValidationSession();

  let currentSql = doc.sql;
  let version = 1;
  const initialState = validationSession.prepareDocument(uri, currentSql);
  const parseRequest = {
    documentUri: uri,
    documentVersion: version,
    sql: currentSql,
    databaseKind: "netezza" as const,
    validationProfile,
  };
  const initialResult = validator.validateWithSession(currentSql, parseSession, parseRequest);
  const initialDiagnostics = getDiagnostics(initialResult);
  for (const statement of initialState.nextIndex.statements) {
    validationSession.storeStatementDiagnostics(
      uri,
      statement,
      diagnosticsForStatement(initialDiagnostics, statement),
    );
  }
  validationSession.commitDocumentIndex(uri, initialState.nextIndex);

  let currentIndex = initialState.nextIndex;
  const targetIndex = Math.floor(currentIndex.statements.length / 2);
  const times: number[] = [];
  const baselineTimes: number[] = [];
  const validatedStatements: number[] = [];
  let metadataReferences = 0;

  for (let edit = 0; edit < WARMUP_EDITS + MEASURED_EDITS; edit++) {
    const target = currentIndex.statements[targetIndex];
    if (!target) {
      throw new Error(`Typing benchmark target statement ${targetIndex} is missing for ${doc.name}`);
    }

    const marker = ` /* typing-${edit} */`;
    currentSql = `${currentSql.slice(0, target.endOffset)}${marker}${currentSql.slice(target.endOffset)}`;
    version++;
    const nextState = validationSession.prepareDocument(uri, currentSql);
    const dirtyIndices = nextState.diff.dirtyIndices;
    const cachedDiagnostics = collectCachedDiagnostics(
      validationSession,
      uri,
      nextState.nextIndex.statements,
      dirtyIndices,
    );

    schemaProvider.takeReferenceCount();
    const start = performance.now();
    const result = validator.validateIncrementalFromStatements(
      currentSql,
      nextState.nextIndex.statements,
      dirtyIndices,
      cachedDiagnostics,
    );
    const elapsed = performance.now() - start;
    metadataReferences += schemaProvider.takeReferenceCount();

    const allDiagnostics = getDiagnostics(result);
    for (const statement of nextState.nextIndex.statements) {
      if (dirtyIndices.includes(statement.index)) {
        validationSession.storeStatementDiagnostics(
          uri,
          statement,
          diagnosticsForStatement(allDiagnostics, statement),
        );
      }
    }
    validationSession.commitDocumentIndex(uri, nextState.nextIndex);
    currentIndex = nextState.nextIndex;
    validatedStatements.push(dirtyIndices.length);

    if (edit < WARMUP_EDITS) {
      baselineTimes.push(elapsed);
    } else {
      times.push(elapsed);
    }
  }

  return {
    document: doc.name,
    actualLines: doc.actualLines,
    iterations: WARMUP_EDITS + MEASURED_EDITS,
    timing: getStats(times),
    baseline: getStats(baselineTimes),
    fullDocumentParses: parseSession.getParseCacheStats().misses,
    validatedStatements,
    metadataReferences,
  };
}

function enforceResult(result: TypingResult): void {
  expect(result.fullDocumentParses).toBe(1);
  expect(result.validatedStatements.every((count) => count === 1)).toBe(true);

  if (!ENFORCE_BUDGETS || result.document !== "XLarge (3000 lines)") {
    return;
  }

  expect(result.timing.medianMs).toBeLessThanOrEqual(20);
  expect(result.timing.p95Ms).toBeLessThanOrEqual(30);
  expect(result.timing.medianMs).toBeLessThanOrEqual(result.baseline.medianMs * 1.1);
  expect(result.timing.p95Ms).toBeLessThanOrEqual(result.baseline.p95Ms * 1.2);
}

function writeResults(results: TypingResult[]): void {
  const lines = [
    "# Typing responsiveness benchmark",
    "",
    `Generated at ${new Date().toISOString()}.`,
    "",
    "| Document | Incremental median | Incremental P95 | Baseline median | Baseline P95 | Full document parses | Metadata refs |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...results.map((result) =>
      `| ${result.document} | ${result.timing.medianMs.toFixed(2)} ms | ${result.timing.p95Ms.toFixed(2)} ms | ${result.baseline.medianMs.toFixed(2)} ms | ${result.baseline.p95Ms.toFixed(2)} ms | ${result.fullDocumentParses} | ${result.metadataReferences} |`,
    ),
    "",
    "Validated statements per edit: " + results.map((result) => `${result.document}=${Math.max(...result.validatedStatements)}`).join(", "),
  ];
  fs.writeFileSync(path.join(__dirname, "typingResponsiveness.results.md"), `${lines.join("\n")}\n`);
}

describe("typing responsiveness benchmark", () => {
  it("keeps one dirty statement incremental across 500, 1000, and 3000 lines", () => {
    assertChangeHandlerDoesNotValidateSynchronously();

    const documents = generateBenchmarkDocuments().filter((doc) => MAX_SQL_LINES.has(doc.targetLines));
    const results = documents.map(runTypingScenario);
    writeResults(results);
    results.forEach(enforceResult);

    expect(results).toHaveLength(3);
  }, 120000);
});
