#!/usr/bin/env node
/**
 * Production-like parser/validator benchmark.
 *
 * Runs the compiled `packages/sql-core/dist` bundle in plain Node. The Jest
 * benchmark it replaces measured ts-jest/Babel transformation overhead as much
 * as parser work (roughly 4-5x inflated medians), so its numbers must not be
 * used for performance claims or limit decisions.
 *
 * Run: npm run benchmark:parser
 * Enforce a local budget: PARSER_PERFORMANCE_ENFORCE=1 npm run benchmark:parser
 */
"use strict";

const { performance } = require("perf_hooks");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  NETEZZA_SQL_VALIDATION_PROFILE,
  NetezzaSqlSemanticValidator,
  collectKeywordTypos,
  parseNetezzaSqlStatements,
} = require("../packages/sql-core/dist/index.js");

const WARMUP = 1;
const ITERATIONS = 5;
const ENFORCE_BUDGET = process.env.PARSER_PERFORMANCE_ENFORCE === "1";
const TEN_THOUSAND_LINE_MEDIAN_BUDGET_MS = 3_000;

function generateProcedure(targetLines, syntaxError) {
  const lines = [
    "CREATE OR REPLACE PROCEDURE BENCH.PUBLIC.LARGE_PROC(A INT)",
    "RETURNS INT",
    "LANGUAGE NZPLSQL AS",
    "BEGIN_PROC",
    "DECLARE",
    "    v_total INT;",
    "    v_counter INT;",
    "BEGIN",
    "    v_total := 0;",
    "    v_counter := 0;",
  ];

  let block = 0;
  while (lines.length < targetLines - 10) {
    lines.push(`    v_total := v_total + ${block % 7};`);
    lines.push(`    INSERT INTO BENCH..T${block % 5} VALUES (${block % 100});`);
    lines.push("    IF v_total > 1000 THEN");
    lines.push("        v_total := v_total - 1000;");
    lines.push("    END IF;");
    block += 1;
  }

  if (syntaxError) {
    lines.push("    SELECT FROM BENCH..BROKEN;");
  }

  lines.push("    RETURN v_total;");
  lines.push("END;");
  lines.push("END_PROC;");
  return lines.join("\n");
}

function generateSelects(targetLines) {
  const lines = [];
  for (let index = 0; index < targetLines; index += 1) {
    lines.push(
      `SELECT t${index % 10}.ID FROM BENCH..T${index % 5} t${index % 10} WHERE t${index % 10}.ID = ${index};`,
    );
  }
  return lines.join("\n");
}

function buildFixtures() {
  const fixtures = [
    { name: "Valid 3k", targetLines: 3_000, syntaxError: false },
    { name: "Valid 5k", targetLines: 5_000, syntaxError: false },
    { name: "Valid 10k", targetLines: 10_000, syntaxError: false },
    { name: "Invalid 10k", targetLines: 10_000, syntaxError: true },
    { name: "Valid 15k", targetLines: 15_000, syntaxError: false },
    { name: "Select 5k", targetLines: 5_000, generator: "selects" },
    { name: "Select 10k", targetLines: 10_000, generator: "selects" },
  ];

  return fixtures.map((fixture) => {
    const sql = fixture.generator === "selects"
      ? generateSelects(fixture.targetLines)
      : generateProcedure(fixture.targetLines, fixture.syntaxError);
    return {
      ...fixture,
      sql,
      lines: sql.split("\n").length,
      chars: sql.length,
    };
  });
}

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function measure(fn) {
  let lastResult;
  for (let index = 0; index < WARMUP; index += 1) {
    lastResult = fn();
  }

  const times = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = performance.now();
    lastResult = fn();
    times.push(performance.now() - start);
  }

  const sorted = [...times].sort((left, right) => left - right);
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    result: lastResult,
  };
}

function countDiagnostics(result) {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (result && Array.isArray(result.errors)) {
    return result.errors.length;
  }
  if (result && Array.isArray(result.actionableParserErrors)) {
    return result.actionableParserErrors.length;
  }
  return 0;
}

function benchmarkFixture(fixture) {
  const parse = measure(() => parseNetezzaSqlStatements({ sql: fixture.sql }));
  const tokens = parse.result.lexResult.tokens;
  const typoScan = measure(() => collectKeywordTypos(tokens));
  const parseResult = parseNetezzaSqlStatements({ sql: fixture.sql });

  const semantic = measure(() => {
    const validator = new NetezzaSqlSemanticValidator(
      undefined,
      NETEZZA_SQL_VALIDATION_PROFILE,
    );
    return validator.validateFromParseResult(fixture.sql, parseResult);
  });

  const endToEnd = measure(
    () =>
      new NetezzaSqlSemanticValidator(
        undefined,
        NETEZZA_SQL_VALIDATION_PROFILE,
      ).validate(fixture.sql),
  );

  return {
    doc: fixture.name,
    lines: fixture.lines,
    chars: fixture.chars,
    tokens: tokens.length,
    parseResult,
    typoScan,
    parse,
    semantic,
    endToEnd,
    diagnostics: countDiagnostics(endToEnd.result),
  };
}

function writeResults(rows) {
  const cpu = os.cpus()[0]?.model ?? "unknown CPU";
  const lines = [
    "# Parser / Validator Performance Benchmark",
    "",
    `Generated at ${new Date().toISOString()}.`,
    "",
    `Environment: Node ${process.version}, ${os.platform()} ${os.arch()}, ${cpu}.`,
    "",
    "Fixtures: an NZPLSQL procedure with repeated assignments, INSERTs, and IF blocks,",
    "plus alias-heavy SELECT statement scripts for the symbol-collector path.",
    "Measured against the compiled `packages/sql-core/dist` bundle in plain Node;",
    "the previous Jest benchmark inflated medians by roughly 4-5x because of ts-jest",
    "and Babel transformation overhead.",
    "",
    "| Document | Lines | Chars | Tokens | Parse median | Parse P95 | Typo scan median | Semantic median | Parse + validate median | Parse + validate P95 | Diagnostics |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.doc} | ${row.lines.toLocaleString()} | ${row.chars.toLocaleString()} `
        + `| ${row.tokens.toLocaleString()} `
        + `| ${row.parse.medianMs.toFixed(1)} ms | ${row.parse.p95Ms.toFixed(1)} ms `
        + `| ${row.typoScan.medianMs.toFixed(1)} ms `
        + `| ${row.semantic.medianMs.toFixed(1)} ms `
        + `| ${row.endToEnd.medianMs.toFixed(1)} ms | ${row.endToEnd.p95Ms.toFixed(1)} ms `
        + `| ${row.diagnostics} |`,
    ),
    "",
    "## Interpretation",
    "",
    "- **Parse** = sanitize + lex + Chevrotain parse (`parseNetezzaSqlStatements`).",
    "- **Typo scan** = detached PAR004 keyword-typo detection over the same token array.",
    "- **Semantic** = `validateFromParseResult` (CST visitor and diagnostics, no re-parse).",
    "- **Parse + validate** = what the extension host runs for an explicit validation with a fresh validator.",
    "- Times are medians of " + ITERATIONS + " runs after " + WARMUP + " warmup run.",
    "",
  ];
  fs.writeFileSync(
    path.join(__dirname, "parserPerformance.results.md"),
    lines.join("\n"),
  );
}

function main() {
  const rows = buildFixtures().map(benchmarkFixture);
  writeResults(rows);
  console.table(
    rows.map((row) => ({
      Document: row.doc,
      Lines: row.lines,
      Chars: row.chars,
      "Parse ms": row.parse.medianMs.toFixed(1),
      "Typo ms": row.typoScan.medianMs.toFixed(1),
      "Semantic ms": row.semantic.medianMs.toFixed(1),
      "Parse+validate ms": row.endToEnd.medianMs.toFixed(1),
      "P95 ms": row.endToEnd.p95Ms.toFixed(1),
      Diagnostics: row.diagnostics,
    })),
  );
  console.log(
    `\nResults written to ${path.join(__dirname, "parserPerformance.results.md")}`,
  );

  if (!ENFORCE_BUDGET) {
    return;
  }

  const tenK = rows.find((row) => row.doc === "Valid 10k");
  if (!tenK) {
    throw new Error("Missing Valid 10k fixture.");
  }
  if (tenK.endToEnd.medianMs > TEN_THOUSAND_LINE_MEDIAN_BUDGET_MS) {
    throw new Error(
      `Valid 10k median ${tenK.endToEnd.medianMs.toFixed(1)} ms exceeds `
      + `the ${TEN_THOUSAND_LINE_MEDIAN_BUDGET_MS} ms budget.`,
    );
  }
}

main();
