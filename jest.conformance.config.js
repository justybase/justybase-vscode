const baseConfig = require("./jest.config.js");

/**
 * Explicit local-only SQL conformance suite.
 *
 * SAFETY: this config selects conformance tests via testMatch, so running it
 * without any --testPathPatterns still cannot pick up the regular unit suite.
 * Every test listed here requires JUSTYBASE_SQL_CONFORMANCE_PATH pointing at
 * a local JustyBase.SqlConformance checkout; nothing here runs in CI.
 *
 *   export JUSTYBASE_SQL_CONFORMANCE_PATH="$(realpath ../JustyBase.SqlConformance)"
 *   npm run test:conformance
 *   npm run test:postgresql:conformance
 */

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  testMatch: [
    "<rootDir>/src/__tests__/sqlParser/sharedLiveConformance.test.ts",
    "<rootDir>/src/__tests__/sqlParser/postgresqlConformance.test.ts",
    "<rootDir>/src/__tests__/sqlParser/postgresqlEditorConformance.test.ts",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/performance/",
  ],
};
