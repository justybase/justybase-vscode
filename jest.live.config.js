const baseConfig = require("./jest.config.js");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  // Live/integration runs must include files ignored by unit config.
  testPathIgnorePatterns: [
    "/node_modules/",
    "/__tests__/performance/",
  ],
};
