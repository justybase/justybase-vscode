const baseConfig = require("./jest.config.js");

/** @type {import('jest').Config} */
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
