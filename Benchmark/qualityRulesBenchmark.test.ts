/**
 * Quality Rules Performance Benchmark
 *
 * Measures extension-host quality rule latency without parser diagnostics.
 *
 * Run: npm run benchmark:quality
 * Enforce budgets: QUALITY_BENCHMARK_ENFORCE=1 npm run benchmark:quality
 */

import { performance } from "perf_hooks";
import * as fs from "fs";
import * as path from "path";
import { generateBenchmarkDocuments } from "./sqlGenerator";
import { getDatabaseSqlAuthoring } from "../src/core/connectionFactory";
import { SqlValidator } from "../src/sqlParser";
import { SqlQualityEngine } from "../src/providers/sqlQualityEngine";

const ITERATIONS = 8;
const WARMUP = 2;
const ENFORCE_QUALITY_BUDGETS = process.env.QUALITY_BENCHMARK_ENFORCE === "1";

const BUDGETS_MS = {
  median: 160,
  p95: 260,
};

const XLARGE_BUDGETS_MS = {
  median: 550,
  p95: 700,
};

interface QualityBenchmarkRow {
  doc: string;
  medianMs: number;
  p95Ms: number;
  issueCount: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function isXLargeDocument(documentName: string): boolean {
  return documentName.includes("3000");
}

function writeResults(rows: QualityBenchmarkRow[]): void {
  const outPath = path.join(__dirname, "qualityRules.results.md");
  const lines = [
    "# Quality Rules Benchmark Results",
    "",
    "| Document | Median ms | P95 ms | Issues |",
    "|----------|-----------|--------|--------|",
    ...rows.map(
      (row) =>
        `| ${row.doc} | ${row.medianMs.toFixed(2)} | ${row.p95Ms.toFixed(2)} | ${row.issueCount} |`,
    ),
    "",
  ];
  fs.writeFileSync(outPath, lines.join("\n"));
}

describe("quality rules benchmark", () => {
  it("keeps quality-rules-only latency within budget", () => {
    const validator = new SqlValidator();
    const engine = new SqlQualityEngine(
      validator,
      getDatabaseSqlAuthoring("netezza").qualityRules,
    );
    const rows: QualityBenchmarkRow[] = [];

    for (const doc of generateBenchmarkDocuments()) {
      let issueCount = 0;
      for (let i = 0; i < WARMUP; i++) {
        issueCount = engine.analyzeQualityRulesOnly(doc.sql).issues.length;
      }

      const times: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        issueCount = engine.analyzeQualityRulesOnly(doc.sql).issues.length;
        times.push(performance.now() - start);
      }

      times.sort((a, b) => a - b);
      rows.push({
        doc: doc.name,
        medianMs: percentile(times, 0.5),
        p95Ms: percentile(times, 0.95),
        issueCount,
      });
    }

    writeResults(rows);

    if (!ENFORCE_QUALITY_BUDGETS) {
      return;
    }

    for (const row of rows) {
      const budget = isXLargeDocument(row.doc) ? XLARGE_BUDGETS_MS : BUDGETS_MS;
      expect(row.medianMs).toBeLessThanOrEqual(budget.median);
      expect(row.p95Ms).toBeLessThanOrEqual(budget.p95);
    }
  });
});
