const baseConfig = require("./jest.config.js");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  setupFiles: [
    ...(baseConfig.setupFiles ?? []),
    "<rootDir>/src/__tests__/integration/db2LiveJestEnv.setup.ts",
  ],
  // Live/integration runs must include files ignored by unit config.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/performance/",
  ],
};
