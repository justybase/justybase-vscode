/**
 * Large-script parser validation benchmark.
 *
 * Measures the synchronous extension-host work behind
 * "Validate SQL (Chevrotain Parser)" for NZPLSQL procedures above the
 * automatic LSP limits. The duration is also the UI-block estimate because
 * the parser and validator run on the extension-host thread.
 *
 * Run: npm run benchmark:large-script
 * Enforce a generous local budget: LARGE_SCRIPT_VALIDATION_ENFORCE=1 npm run benchmark:large-script
 */

import { performance, monitorEventLoopDelay } from "perf_hooks";
import * as fs from "fs";
import * as path from "path";
import { getDatabaseSqlAuthoring } from "../src/core/connectionFactory";
import { SqlCoreBackedValidator } from "../src/sqlParser/sqlCoreBackedValidator";
import { SqlQualityEngine } from "../src/providers/sqlQualityEngine";

const WARMUP = 1;
const ITERATIONS = 3;
const FRAME_BUDGET_MS = 1000 / 60;
const ENFORCE_BUDGET = process.env.LARGE_SCRIPT_VALIDATION_ENFORCE === "1";
const TEN_THOUSAND_LINE_MEDIAN_BUDGET_MS = 15_000;

interface DocumentFixture {
  name: string;
  targetLines: number;
  sql: string;
  lines: number;
  chars: number;
  syntaxError: boolean;
}

interface BenchmarkRow {
  doc: string;
  lines: number;
  chars: number;
  syntaxError: boolean;
  validationMedianMs: number;
  validationP95Ms: number;
  eventLoopGapMs: number;
  blockedFrames: number;
  qualityMedianMs: number;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  ] ?? 0;
}

function stats(values: number[]): { medianMs: number; p95Ms: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function generateProcedure(targetLines: number, syntaxError: boolean): string {
  const lines: string[] = [
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
    block++;
  }

  if (syntaxError) {
    lines.push("    SELECT FROM BENCH..BROKEN;");
  }

  lines.push("    RETURN v_total;");
  lines.push("END;");
  lines.push("END_PROC;");
  return lines.join("\n");
}

function buildFixtures(): DocumentFixture[] {
  const fixtures: Array<{ name: string; targetLines: number; syntaxError: boolean }> = [
    { name: "Valid 3k", targetLines: 3_000, syntaxError: false },
    { name: "Valid 5k", targetLines: 5_000, syntaxError: false },
    { name: "Valid 10k", targetLines: 10_000, syntaxError: false },
    { name: "Invalid 10k", targetLines: 10_000, syntaxError: true },
    { name: "Valid 15k", targetLines: 15_000, syntaxError: false },
  ];

  return fixtures.map((fixture) => {
    const sql = generateProcedure(fixture.targetLines, fixture.syntaxError);
    return {
      ...fixture,
      sql,
      lines: sql.split("\n").length,
      chars: sql.length,
    };
  });
}

function measureValidation(sql: string): {
  durationMs: number;
  eventLoopGapMs: number;
  errors: number;
  warnings: number;
} {
  const profile = getDatabaseSqlAuthoring("netezza").validation;
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  const start = performance.now();
  // Match the command path: a fresh validator is created per explicit run.
  const validator = new SqlCoreBackedValidator(undefined, profile);
  const result = validator.validate(sql);
  const durationMs = performance.now() - start;

  histogram.disable();
  histogram.reset();

  return {
    durationMs,
    eventLoopGapMs: Math.max(durationMs, histogram.max / 1_000_000),
    errors: result.errors.length,
    warnings: result.warnings.length,
  };
}

function measureQuality(sql: string): number {
  const profile = getDatabaseSqlAuthoring("netezza");
  const validator = new SqlCoreBackedValidator(undefined, profile.validation);
  const engine = new SqlQualityEngine(validator, profile.qualityRules);
  const start = performance.now();
  engine.analyzeQualityRulesOnly(sql);
  return performance.now() - start;
}

function writeResults(rows: BenchmarkRow[]): void {
  const lines = [
    "# Large Script Validation Benchmark",
    "",
    `Generated at ${new Date().toISOString()}.`,
    "",
    "Synchronous extension-host work behind `Validate SQL (Chevrotain Parser)`.",
    "The max event-loop gap is the longest observed stall while the parser ran;",
    "it is the practical UI-block estimate because the parse executes on the extension-host thread.",
    "",
    "| Document | Lines | Chars | Parse + validate median | P95 | Max event-loop gap | Blocked 60fps frames | Quality median |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.doc} | ${row.lines.toLocaleString()} | ${row.chars.toLocaleString()} `
        + `| ${row.validationMedianMs.toFixed(1)} ms | ${row.validationP95Ms.toFixed(1)} ms `
        + `| ${row.eventLoopGapMs.toFixed(1)} ms | ${row.blockedFrames} | ${row.qualityMedianMs.toFixed(1)} ms |`,
    ),
    "",
    "## Interpretation",
    "",
    "- **Parse + validate** is the time the extension host cannot service other work (the forced command shows a progress notification first).",
    "- **Blocked 60fps frames** = `ceil(median / 16.7 ms)`; values above ~5 frames are noticeable UI jank.",
    "- **Quality median** is the separate on-demand NZ/NZP lint path (`Ctrl+Shift+L`); procedure fallback parsing is cached once per evaluation.",
    "- The 10k-line rows are the reported real-world case; `Invalid 10k` includes a syntax error near the end.",
    "",
    "## Limit guidance",
    "",
    "- Current automatic LSP limits: `150,000` characters or `3,000` lines.",
    "- A 5k-line / 140k-character procedure costs about one second; raising only the line limit to 5k is defensible after the 2s large-script debounce.",
    "- A 10k-line / 281k-character procedure costs 2-3 seconds (p95 above 4s) and would block the single-threaded language server after every pause. Keep it on the explicit `Validate SQL` path instead of raising the default.",
    "",
  ];
  fs.writeFileSync(
    path.join(__dirname, "largeScriptValidation.results.md"),
    lines.join("\n"),
  );
}

describe("large script validation benchmark", () => {
  it("measures extension-host parser blocking for 3k, 5k, 10k, and 15k line procedures", () => {
    const rows: BenchmarkRow[] = [];

    for (const fixture of buildFixtures()) {
      for (let i = 0; i < WARMUP; i++) {
        measureValidation(fixture.sql);
      }

      const validationTimes: number[] = [];
      let eventLoopGapMs = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const measurement = measureValidation(fixture.sql);
        validationTimes.push(measurement.durationMs);
        eventLoopGapMs = Math.max(eventLoopGapMs, measurement.eventLoopGapMs);
      }

      const validation = stats(validationTimes);
      const qualityMedianMs = measureQuality(fixture.sql);
      rows.push({
        doc: fixture.name,
        lines: fixture.lines,
        chars: fixture.chars,
        syntaxError: fixture.syntaxError,
        validationMedianMs: validation.medianMs,
        validationP95Ms: validation.p95Ms,
        eventLoopGapMs,
        blockedFrames: Math.ceil(validation.medianMs / FRAME_BUDGET_MS),
        qualityMedianMs,
      });
    }

    writeResults(rows);
    console.table(rows);

    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.validationMedianMs > 0)).toBe(true);

    if (!ENFORCE_BUDGET) {
      return;
    }

    for (const row of rows) {
      if (row.doc !== "Valid 10k") {
        continue;
      }
      expect(row.validationMedianMs).toBeLessThanOrEqual(
        TEN_THOUSAND_LINE_MEDIAN_BUDGET_MS,
      );
    }
  }, 240_000);
});
