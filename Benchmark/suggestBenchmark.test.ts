/**
 * Suggest Performance Benchmark
 *
 * Measures the execution time of each stage in the SQL suggest/autocomplete pipeline
 * across documents of varying size and complexity.
 *
 * Run with:
 *   npx jest Benchmark/suggestBenchmark.test.ts --no-cache
 *   (or) npx ts-node Benchmark/run.ts
 */

import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { generateBenchmarkDocuments, BenchmarkDocument } from './sqlGenerator';

// --- Import the functions under test ---
import { stripComments } from '../src/providers/parsers/commentStripper';
import { parseLocalDefinitions } from '../src/providers/parsers/sqlParser';
import { parseLocalDefinitionsWithParser, parseAliasBindingsWithParser } from '../src/providers/parsers/parserSqlContext';
import { parseVariables } from '../src/providers/parsers/variableParser';
import { SqlLexer } from '../src/sqlParser';
import { SqlParser } from '../src/sql/sqlParser';

// ========== Benchmark Helpers ==========

const ITERATIONS = 10;
const WARMUP_ITERATIONS = 2;

interface BenchmarkResult {
    stage: string;
    docName: string;
    actualLines: number;
    actualChars: number;
    medianMs: number;
    minMs: number;
    maxMs: number;
    p95Ms: number;
}

/**
 * Run a function multiple times and return timing statistics.
 */
function benchmark(fn: () => void): { medianMs: number; minMs: number; maxMs: number; p95Ms: number } {
    // Warmup
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        fn();
    }

    const times: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        fn();
        const elapsed = performance.now() - start;
        times.push(elapsed);
    }

    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length / 2)];
    const minMs = times[0];
    const maxMs = times[times.length - 1];
    const p95Ms = times[Math.floor(times.length * 0.95)];

    return { medianMs, minMs, maxMs, p95Ms };
}

// ========== Test Suite ==========

describe('Suggest Performance Benchmark', () => {
    let docs: BenchmarkDocument[];
    const allResults: BenchmarkResult[] = [];

    beforeAll(() => {
        docs = generateBenchmarkDocuments();

        console.log('\n📊 Generated Benchmark Documents:');
        console.log('─'.repeat(60));
        for (const doc of docs) {
            console.log(`  ${doc.name.padEnd(22)} → ${doc.actualLines} lines, ${doc.actualChars.toLocaleString()} chars`);
        }
        console.log('─'.repeat(60));
        console.log(`  Iterations: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)\n`);
    });

    afterAll(() => {
        // Print final summary table
        printResultsTable(allResults);
        // Save results to file
        saveResultsFile(allResults, docs);
    });

    // --- Stage 1: stripComments ---
    describe('Stage 1: stripComments', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const result = benchmark(() => {
                stripComments(doc.sql);
            });
            allResults.push({ stage: 'stripComments', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('stripComments', doc, result);
        });
    });

    // --- Stage 2: parseLocalDefinitions (regex) ---
    describe('Stage 2: parseLocalDefinitions (regex)', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const cleanSql = stripComments(doc.sql);
            const result = benchmark(() => {
                parseLocalDefinitions(cleanSql);
            });
            allResults.push({ stage: 'parseLocalDefs (regex)', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('parseLocalDefs (regex)', doc, result);
        });
    });

    // --- Stage 3: parseLocalDefinitionsWithParser (Chevrotain) ---
    describe('Stage 3: parseLocalDefinitionsWithParser (Chevrotain)', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const cleanSql = stripComments(doc.sql);
            const result = benchmark(() => {
                parseLocalDefinitionsWithParser(cleanSql);
            });
            allResults.push({ stage: 'parseLocalDefs (parser)', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('parseLocalDefs (parser)', doc, result);
        });
    });

    // --- Stage 4: parseVariables ---
    describe('Stage 4: parseVariables', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const cleanSql = stripComments(doc.sql);
            const result = benchmark(() => {
                parseVariables(cleanSql);
            });
            allResults.push({ stage: 'parseVariables', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('parseVariables', doc, result);
        });
    });

    // --- Stage 5: SqlLexer.tokenize ---
    describe('Stage 5: SqlLexer.tokenize', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const cleanSql = stripComments(doc.sql);
            const result = benchmark(() => {
                SqlLexer.tokenize(cleanSql);
            });
            allResults.push({ stage: 'SqlLexer.tokenize', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('SqlLexer.tokenize', doc, result);
        });
    });

    // --- Stage 6: parseAliasBindingsWithParser ---
    describe('Stage 6: parseAliasBindingsWithParser', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const cleanSql = stripComments(doc.sql);
            const result = benchmark(() => {
                parseAliasBindingsWithParser(cleanSql);
            });
            allResults.push({ stage: 'parseAliasBindings', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('parseAliasBindings', doc, result);
        });
    });

    // --- Stage 7: SqlParser.getStatementAtPosition ---
    describe('Stage 7: SqlParser.getStatementAtPosition', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            // Position cursor at ~75% through the document
            const offset = Math.floor(doc.sql.length * 0.75);
            const result = benchmark(() => {
                SqlParser.getStatementAtPosition(doc.sql, offset);
            });
            allResults.push({ stage: 'getStatementAtPos', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('getStatementAtPos', doc, result);
        });
    });

    // --- Stage 8: Full Pipeline ---
    describe('Stage 8: Full Pipeline (stripComments + parseLocalDefs + parseVariables)', () => {
        it.each([0, 1, 2, 3, 4])('doc[%i]', (idx) => {
            const doc = docs[idx];
            const result = benchmark(() => {
                const cleanSql = stripComments(doc.sql);
                parseLocalDefinitionsWithParser(cleanSql);
                parseVariables(cleanSql);
            });
            allResults.push({ stage: 'FULL PIPELINE', docName: doc.name, actualLines: doc.actualLines, actualChars: doc.actualChars, ...result });
            logStageResult('FULL PIPELINE', doc, result);
        });
    });
});

// ========== Reporting ==========

function logStageResult(
    stage: string,
    doc: BenchmarkDocument,
    result: { medianMs: number; minMs: number; maxMs: number; p95Ms: number }
) {
    const line = `  ${stage.padEnd(26)} | ${doc.name.padEnd(22)} | median: ${result.medianMs.toFixed(2).padStart(8)} ms | min: ${result.minMs.toFixed(2).padStart(8)} ms | max: ${result.maxMs.toFixed(2).padStart(8)} ms`;
    console.log(line);
}

function printResultsTable(results: BenchmarkResult[]) {
    console.log('\n\n');
    console.log('═'.repeat(120));
    console.log('  📊 SUGGEST PERFORMANCE BENCHMARK — RESULTS SUMMARY');
    console.log('═'.repeat(120));

    // Group by stage
    const stages = [...new Set(results.map(r => r.stage))];
    const docNames = [...new Set(results.map(r => r.docName))];

    // Print header
    const header = '  Stage'.padEnd(30) + docNames.map(d => d.padStart(20)).join('');
    console.log(header);
    console.log('─'.repeat(30 + docNames.length * 20));

    for (const stage of stages) {
        const stageResults = results.filter(r => r.stage === stage);
        const values = docNames.map(d => {
            const r = stageResults.find(sr => sr.docName === d);
            return r ? `${r.medianMs.toFixed(2)} ms`.padStart(20) : ''.padStart(20);
        }).join('');
        const isFull = stage === 'FULL PIPELINE';
        console.log(`${isFull ? '▸ ' : '  '}${stage.padEnd(28)}${values}`);
    }

    console.log('─'.repeat(30 + docNames.length * 20));
    console.log('  (all values are median of 10 iterations, in milliseconds)');
    console.log('═'.repeat(120));
    console.log('\n');
}

function saveResultsFile(results: BenchmarkResult[], docs: BenchmarkDocument[]) {
    const stages = [...new Set(results.map(r => r.stage))];
    const docNames = [...new Set(results.map(r => r.docName))];
    const lines: string[] = [];
    lines.push(`# Suggest Performance Benchmark Results`);
    lines.push('');
    lines.push(`> Iterations: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)`);
    lines.push('');

    lines.push('## Document Sizes');
    lines.push('');
    lines.push('| Document | Target Lines | Actual Lines | Characters |');
    lines.push('|----------|-------------|-------------|------------|');
    for (const doc of docs) {
        lines.push(`| ${doc.name} | ${doc.targetLines} | ${doc.actualLines} | ${doc.actualChars.toLocaleString()} |`);
    }
    lines.push('');

    lines.push('## Results (median ms)');
    lines.push('');
    lines.push(`| Stage | ${docNames.join(' | ')} |`);
    lines.push(`| --- | ${docNames.map(() => '---:').join(' | ')} |`);

    for (const stage of stages) {
        const vals = docNames.map(d => {
            const r = results.find(sr => sr.stage === stage && sr.docName === d);
            return r ? r.medianMs.toFixed(2) : '-';
        });
        lines.push(`| ${stage} | ${vals.join(' | ')} |`);
    }
    lines.push('');

    lines.push('## Detailed Results (min / median / max / p95)');
    lines.push('');
    for (const stage of stages) {
        lines.push(`### ${stage}`);
        lines.push('');
        lines.push('| Document | Min (ms) | Median (ms) | Max (ms) | P95 (ms) |');
        lines.push('|----------|---------|------------|---------|---------|');
        for (const doc of docs) {
            const r = results.find(sr => sr.stage === stage && sr.docName === doc.name);
            if (r) {
                lines.push(`| ${doc.name} | ${r.minMs.toFixed(2)} | ${r.medianMs.toFixed(2)} | ${r.maxMs.toFixed(2)} | ${r.p95Ms.toFixed(2)} |`);
            }
        }
        lines.push('');
    }

    const outPath = path.join(__dirname, 'results.md');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
    console.log(`  📄 Results saved to: ${outPath}`);
}
