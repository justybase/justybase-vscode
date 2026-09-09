#!/usr/bin/env node

/**
 * Keep optional companion extensions independent from the desktop source tree.
 *
 * The architecture graph is the source of truth for resolution (including
 * tsconfig path aliases), so this check deliberately inspects resolved edges
 * instead of trying to recognize import syntax with regular expressions.
 */
import { analyzeArchitecture } from './architecture-check.mjs';

const result = analyzeArchitecture();
const violations = result.edges.filter(edge => (
  edge.source.startsWith('extensions/')
  && edge.target.startsWith('src/')
));

if (result.diagnostics.length > 0) {
  console.error('Companion boundary check cannot run with architecture diagnostics:');
  for (const diagnostic of result.diagnostics) console.error(`- ${diagnostic.code}: ${diagnostic.message}`);
  process.exitCode = 1;
} else if (violations.length > 0) {
  console.error('Companion boundary violations: optional extensions must not import desktop source files:');
  for (const violation of violations) {
    console.error(`- ${violation.source}:${violation.line} -> ${violation.target}`);
  }
  process.exitCode = 1;
} else {
  console.log('Companion boundary check passed (no extensions/* production edge targets src/*).');
}
