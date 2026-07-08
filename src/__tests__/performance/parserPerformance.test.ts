/**
 * Parser Performance Tests
 *
 * Measures lexer, parser, and autocomplete suggestion generation time
 * for ~1MB SQL files. Reports min/max/avg/median and FAILS if thresholds
 * are exceeded.
 *
 * Run with:
 *   JEST_SILENT=0 npx jest src/__tests__/performance/parserPerformance.test.ts --no-cache --runInBand
 */

import { jest } from "@jest/globals";
import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';

// Unmock chevrotain - the mock in __mocks__/chevrotain.ts provides
// a substitute CstParser that does NOT support all OPTION/N variants
// used by the real grammar (e.g. OPTION6).
jest.unmock("chevrotain");

const { SqlLexer } = require('../../sqlParser');
const { parseSqlStatements } = require('../../sqlParser/parsingRuntime');
const { SqlParser } = require('../../sql/sqlParser');

// ========== Config ==========

const ITERATIONS = 5;
const WARMUP = 2;

// Acceptable thresholds (average time in ms)
const THRESHOLDS = {
  tokenize: 500,
  parse: 1200,
  autocomplete: 300,
};

// ========== Helpers ==========

interface PerfResult {
  label: string;
  file: string;
  minMs: number;
  maxMs: number;
  avgMs: number;
  medianMs: number;
  valuesMs: number[];
}

function computeStats(times: number[]): { minMs: number; maxMs: number; avgMs: number; medianMs: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const avgMs = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const medianMs = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  return { minMs, maxMs, avgMs, medianMs };
}

function benchmark(fn: () => void): { minMs: number; maxMs: number; avgMs: number; medianMs: number; valuesMs: number[] } {
  for (let i = 0; i < WARMUP; i++) {
    fn();
  }
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return { ...computeStats(times), valuesMs: times };
}

function toFixed(v: number): string {
  return v.toFixed(2).padStart(9);
}

function printTable(results: PerfResult[]) {
  console.log('');
  console.log('='.repeat(110));
  console.log('  SQL PARSER PERFORMANCE BENCHMARK');
  console.log('='.repeat(110));
  console.log(`  Iterations: ${ITERATIONS} (+ ${WARMUP} warmup) | Thresholds: tokenize<${THRESHOLDS.tokenize}ms parse<${THRESHOLDS.parse}ms`);
  console.log('');
  console.log('  '.padEnd(30) + '│'.padEnd(4) + 'file'.padEnd(22) + '│ min(ms) │ max(ms) │ avg(ms)  │ median(ms)');
  console.log('  ' + '─'.repeat(28) + '┼' + '─'.repeat(22) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(9) + '┼' + '─'.repeat(10));
  for (const r of results) {
    const flag = r.label.includes('FAIL') ? '⚠ ' : '  ';
    console.log(`  ${flag}${r.label.padEnd(28)}│ ${r.file.padEnd(20)}│ ${toFixed(r.minMs)} │ ${toFixed(r.maxMs)} │ ${toFixed(r.avgMs)} │ ${toFixed(r.medianMs)}`);
  }
  console.log('='.repeat(110));
  console.log('');
}

function printMemory(mb: number) {
  console.log(`  Heap Used: ${mb.toFixed(1)} MB`);
}

function loadFixture(name: string): string {
  const fixtureDir = path.resolve(__dirname, '..', '..', 'test', 'performance', 'fixtures');
  const filePath = path.join(fixtureDir, name);
  const sql = fs.readFileSync(filePath, 'utf-8');
  return sql;
}

const FIXTURES = [
  { name: 'perf_ddl_heavy.sql', label: 'DDL' },
  { name: 'perf_dml_heavy.sql', label: 'DML' },
  { name: 'perf_complex_queries.sql', label: 'Complex' },
];

// ========== Tests ==========

describe('Parser Performance', () => {
  const allResults: PerfResult[] = [];
  const sqlCache = new Map<string, string>();

  beforeAll(() => {
    for (const f of FIXTURES) {
      sqlCache.set(f.name, loadFixture(f.name));
      const size = Buffer.byteLength(sqlCache.get(f.name)!, 'utf-8');
      console.log(`  Loaded ${f.label.padEnd(10)} → ${f.name} (${(size / 1024).toFixed(0)} KB)`);
    }
  });

  afterAll(() => {
    printTable(allResults);

    // Check thresholds
    for (const r of allResults) {
      if (r.label.startsWith('tokenize') && r.avgMs >= THRESHOLDS.tokenize) {
        console.error(`  ❌ FAIL: ${r.label} avg ${r.avgMs.toFixed(1)}ms >= ${THRESHOLDS.tokenize}ms threshold`);
      }
      if (r.label.startsWith('parse') && r.avgMs >= THRESHOLDS.parse) {
        console.error(`  ❌ FAIL: ${r.label} avg ${r.avgMs.toFixed(1)}ms >= ${THRESHOLDS.parse}ms threshold`);
      }
      if (r.label.startsWith('autocomplete') && r.avgMs >= THRESHOLDS.autocomplete) {
        console.error(`  ❌ FAIL: ${r.label} avg ${r.avgMs.toFixed(1)}ms >= ${THRESHOLDS.autocomplete}ms threshold`);
      }
    }
  });

  // ── Tokenization ───────────────────────────────────────────────────────
  describe('Tokenization', () => {
    for (const f of FIXTURES) {
      it(`tokenize ${f.label}`, () => {
        const sql = sqlCache.get(f.name)!;
        const result = benchmark(() => {
          SqlLexer.tokenize(sql);
        });
        const label = `tokenize ${f.label}`;
        allResults.push({ label, file: f.name, ...result });
        expect(result.avgMs).toBeLessThan(THRESHOLDS.tokenize);
      });
    }
  });

  // ── Parsing ────────────────────────────────────────────────────────────
  describe('Parsing', () => {
    for (const f of FIXTURES) {
      it(`parse ${f.label}`, () => {
        const sql = sqlCache.get(f.name)!;
        const result = benchmark(() => {
          parseSqlStatements({ sql });
        });
        const label = `parse ${f.label}`;
        allResults.push({ label, file: f.name, ...result });
        expect(result.avgMs).toBeLessThan(THRESHOLDS.parse);
      });
    }
  });

  // ── Autocomplete suggestions ──────────────────────────────────────────
  describe('Autocomplete suggestion generation', () => {
    const complexSql = FIXTURES[2];
    it(`autocomplete suggestions at 5 positions in ${complexSql.label}`, () => {
      const sql = sqlCache.get(complexSql.name)!;
      const positions = [
        Math.floor(sql.length * 0.10),
        Math.floor(sql.length * 0.25),
        Math.floor(sql.length * 0.50),
        Math.floor(sql.length * 0.75),
        Math.floor(sql.length * 0.90),
      ];
      for (let p = 0; p < positions.length; p++) {
        const offset = positions[p];
        const result = benchmark(() => {
          SqlParser.getStatementAtPosition(sql, offset);
        });
        const label = `autocomplete pos${p + 1}`;
        allResults.push({ label, file: complexSql.name, ...result });
        expect(result.avgMs).toBeLessThan(THRESHOLDS.autocomplete);
      }
    });
  });

  // ── Memory usage ──────────────────────────────────────────────────────
  describe('Memory usage', () => {
    for (const f of FIXTURES) {
      it(`memory before/after parse ${f.label}`, () => {
        const sql = sqlCache.get(f.name)!;
        global.gc?.();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 3; i++) {
          SqlLexer.tokenize(sql);
          parseSqlStatements({ sql });
        }
        const after = process.memoryUsage().heapUsed;
        const deltaMB = (after - before) / (1024 * 1024);
        printMemory(deltaMB);
        allResults.push({
          label: `memory ${f.label}`,
          file: f.name,
          minMs: deltaMB,
          maxMs: deltaMB,
          avgMs: deltaMB,
          medianMs: deltaMB,
          valuesMs: [deltaMB],
        });
        expect(deltaMB).toBeLessThan(500);
      });
    }
  });
});
