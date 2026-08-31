const baseConfig = require("./jest.config.js");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  // Live suites own their network lifecycle and must replace the unit guard.
  setupFiles: ["<rootDir>/src/__tests__/integration/db2LiveJestEnv.setup.ts"],
  // Live/integration runs must include files ignored by unit config.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/performance/",
  ],
};
