/**
 * Standalone Benchmark Runner
 *
 * This file is designed to be run through Jest (which handles ESM module transforms
 * for Chevrotain and other dependencies). Run with:
 *
 *   npx jest --config Benchmark/jest.config.js --verbose
 *
 * The benchmark results will be printed to the console and saved to Benchmark/results.md.
 *
 * Why Jest instead of ts-node? The Chevrotain parser and related deps are ESM-only.
 * The Jest config already handles the CJS transform (via babel-jest), so running
 * through Jest is the most reliable approach. The standalone runner below is provided
 * as a reference but requires the same ESM transforms to work standalone.
 */

// Re-export everything from the test file for reference
export { generateBenchmarkDocuments } from './sqlGenerator';
