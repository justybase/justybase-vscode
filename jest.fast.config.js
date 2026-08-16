const baseConfig = require("./jest.config.js");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...baseConfig,
  testPathIgnorePatterns: [
    ...(baseConfig.testPathIgnorePatterns ?? []),
    "completionEngine.test.ts",
    "metadataCache.test.ts",
    "sqlLinter.test.ts",
    "sqlValidator.test.ts",
    "validator.advanced.test.ts",
    "extension.test.ts",
  ],
};
