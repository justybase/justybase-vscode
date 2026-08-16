/**
 * Extension-Host Linter Benchmark
 *
 * Measures the extension-host linter path (`SqlLinterProvider.lintSql`)
 * for Netezza SQL documents of varying sizes, comparing:
 *   - Cold (first) lint pass: non-incremental
 *   - Warm lint with N dirty statements: incremental (per-statement)
 *   - Warm lint with 0 dirty statements: incremental fast-path (cached)
 *
 * Run: jest --config Benchmark/jest.config.js Benchmark/extensionLinterBenchmark.test.ts
 */

import { performance } from "perf_hooks";
import * as fs from "fs";
import * as path from "path";
import { generateBenchmarkDocuments } from "./sqlGenerator";
import { SqlLinterProvider } from "../src/providers/sqlLinterProvider";

const ITERATIONS = 6;
const WARMUP = 2;

interface ScenarioRow {
  doc: string;
  coldMedianMs: number;
  warm1DirtyMedianMs: number;
  warm10DirtyMedianMs: number;
  warm30DirtyMedianMs: number;
  warm0DirtyMedianMs: number;
  warm1OverColdRatio: number;
  warm0OverColdRatio: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function medianP95(times: number[]): { medianMs: number; p95Ms: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function editNthStatement(sql: string, n: number): string {
  const statements = sql.split(";");
  if (n >= statements.length) {
    return sql + " -- incremental edit";
  }
  statements[n] = `${statements[n]} /*edit*/`;
  return statements.join(";");
}

function markNStatementsDirty(
  sql: string,
  dirtyCount: number,
): { editedSql: string; dirtyIndices: number[] } {
  const statements = sql.split(";");
  const totalCount = statements.length;
  const dirtyIndices: number[] = [];
  for (let i = 0; i < Math.min(dirtyCount, totalCount); i++) {
    const idx = Math.floor((i / dirtyCount) * totalCount);
    statements[idx] = `${statements[idx]} /*d*/`;
    dirtyIndices.push(idx);
  }
  return { editedSql: statements.join(";"), dirtyIndices };
}

function writeResults(rows: ScenarioRow[]): void {
  const outPath = path.join(__dirname, "extensionLinter.results.md");
  const lines: string[] = [];
  lines.push("# Extension-Host Linter Benchmark Results");
  lines.push("");
  lines.push("Measures `SqlLinterProvider.lintSql` for Netezza SQL documents of varying sizes.");
  lines.push("");
  lines.push("| Document | Cold (median ms) | Warm 1 dirty (ms) | Warm 10 dirty (ms) | Warm 30 dirty (ms) | Warm 0 dirty (ms) | Warm 1 / Cold | Warm 0 / Cold |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    lines.push(
      `| ${row.doc} | ${row.coldMedianMs.toFixed(2)} | ${row.warm1DirtyMedianMs.toFixed(2)} | ${row.warm10DirtyMedianMs.toFixed(2)} | ${row.warm30DirtyMedianMs.toFixed(2)} | ${row.warm0DirtyMedianMs.toFixed(2)} | ${row.warm1OverColdRatio.toFixed(2)}x | ${row.warm0OverColdRatio.toFixed(2)}x |`,
    );
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  lines.push(
    "- **Cold**: first lint pass (version 1), non-incremental — full visitor walk.",
  );
  lines.push(
    "- **Warm N dirty**: N statements edited; incremental path skips non-dirty statements via cached diagnostics.",
  );
  lines.push(
    "- **Warm 0 dirty**: no edits, fast-path returns cached diagnostics without `buildScopeSeeds` / `validateStatementText`.",
  );
  lines.push(
    "- Ratios > 1 mean warm pass is faster than cold (expected: warm 1 dirty should be much faster).",
  );
  lines.push("");
  fs.writeFileSync(outPath, lines.join("\n"));
}

describe("extension-host linter benchmark", () => {
  it("measures cold + warm lint passes with varying dirty counts", async () => {
    const rows: ScenarioRow[] = [];

    for (const doc of generateBenchmarkDocuments()) {
      const coldTimes: number[] = [];
      const warm1Times: number[] = [];
      const warm10Times: number[] = [];
      const warm30Times: number[] = [];
      const warm0Times: number[] = [];

      for (let i = 0; i < WARMUP + ITERATIONS; i++) {
        const linter = new SqlLinterProvider();
        const uri = `benchmark://ext-linter/${doc.name}`;
        const rulesConfig: Record<string, never> = {};

        const t0 = performance.now();
        await linter.lintSql(doc.sql, rulesConfig, false, undefined, uri, 1);
        coldTimes.push(performance.now() - t0);

        const edited1 = editNthStatement(doc.sql, Math.floor(doc.sql.length / 2));
        const t1 = performance.now();
        await linter.lintSql(edited1, rulesConfig, false, undefined, uri, 2);
        warm1Times.push(performance.now() - t1);

        const { editedSql: edited10 } = markNStatementsDirty(doc.sql, 10);
        const t10 = performance.now();
        await linter.lintSql(edited10, rulesConfig, false, undefined, uri, 3);
        warm10Times.push(performance.now() - t10);

        const { editedSql: edited30 } = markNStatementsDirty(doc.sql, 30);
        const t30 = performance.now();
        await linter.lintSql(edited30, rulesConfig, false, undefined, uri, 4);
        warm30Times.push(performance.now() - t30);

        const tNoop = performance.now();
        await linter.lintSql(doc.sql, rulesConfig, false, undefined, uri, 5);
        warm0Times.push(performance.now() - tNoop);
      }

      const cold = medianP95(coldTimes.slice(WARMUP));
      const warm1 = medianP95(warm1Times.slice(WARMUP));
      const warm10 = medianP95(warm10Times.slice(WARMUP));
      const warm30 = medianP95(warm30Times.slice(WARMUP));
      const warm0 = medianP95(warm0Times.slice(WARMUP));

      rows.push({
        doc: doc.name,
        coldMedianMs: cold.medianMs,
        warm1DirtyMedianMs: warm1.medianMs,
        warm10DirtyMedianMs: warm10.medianMs,
        warm30DirtyMedianMs: warm30.medianMs,
        warm0DirtyMedianMs: warm0.medianMs,
        warm1OverColdRatio: cold.medianMs / Math.max(warm1.medianMs, 0.001),
        warm0OverColdRatio: cold.medianMs / Math.max(warm0.medianMs, 0.001),
      });
    }

    writeResults(rows);
    console.table(rows);
  });
});
