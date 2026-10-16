const baseConfig = require("./jest.config.js");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  // Live suites own their network lifecycle; do not install the hermetic unit guard.
  setupFiles: [],
  // Live/integration runs must include files ignored by unit config.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/performance/",
  ],
};
