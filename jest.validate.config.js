const baseConfig = require("./jest.config.js");
const liveDbIgnorePatterns = require("./scripts/jestLiveDbIgnorePatterns.cjs");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/performance/",
    ...liveDbIgnorePatterns,
  ],
};
