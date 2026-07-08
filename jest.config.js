const jestSilent = process.env.JEST_SILENT !== "0";
const jestVerbose = process.env.JEST_VERBOSE === "1";
const jestLogHeapUsage = process.env.JEST_LOG_HEAP === "1";
const jestMaxWorkers = process.env.JEST_MAX_WORKERS ?? "50%";

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    "realDatabase.integration.test.ts",
    "optionalDialects.live.integration.test.ts",
    "postgres.integration.test.ts",
    "duckdb.integration.test.ts",
    "snowflake.integration.test.ts",
    "mysql.integration.test.ts",
    "mssql.integration.test.ts",
    "oracle.integration.test.ts",
    "db2.integration.test.ts",
    "vertica.integration.test.ts",
    "/__tests__/performance/",
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  resolver: "<rootDir>/scripts/jest-media-resolver.cjs",
  transform: {
    "^.+\\/media\\/.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.media.json",
        isolatedModules: true,
      },
    ],
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
        isolatedModules: true,
      },
    ],
    // Chevrotain (+ its deps) are ESM; transform them to CJS for Jest.
    "^.+\\.[mc]?js$": [
      "babel-jest",
      {
        presets: [
          [
            "@babel/preset-env",
            { targets: { node: "current" }, modules: "commonjs" },
          ],
        ],
      },
    ],
  },
  // Mock modules not available in test environment
  moduleNameMapper: {
    "^vscode$": "<rootDir>/src/__tests__/__mocks__/vscode.ts",
    "^@justybase/contracts$": "<rootDir>/packages/contracts/src/index.ts",
    "^@justybase/contracts/(.*)$": "<rootDir>/packages/contracts/src/$1",
    "^(.*/media/.+)\\.js$": "$1.ts",
    // Jest (CJS) cannot resolve ESM-only packages with "exports: { import: ... }" conditions.
    "^hyparquet$": "<rootDir>/node_modules/hyparquet/src/index.js",
    "^hyparquet/src/(.*)\\.js$": "<rootDir>/node_modules/hyparquet/src/$1.js",
    "^hyparquet-writer$": "<rootDir>/node_modules/hyparquet-writer/src/index.js",
    "^hyparquet-writer/src/(.*)\\.js$": "<rootDir>/node_modules/hyparquet-writer/src/$1.js",
    "^hyparquet-compressors$": "<rootDir>/node_modules/hyparquet-compressors/src/index.js",
    "^@chevrotain/(.+)$":
      "<rootDir>/node_modules/@chevrotain/$1/lib/src/api.js",
  },
  transformIgnorePatterns: [
    // Transform ESM deps used by the SQL parser.
    "/node_modules/(?!chevrotain|@chevrotain|lodash-es|hyparquet|hyparquet-writer|hyparquet-compressors|fzstd|hysnappy)/",
  ],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/__tests__/**"],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "lcov"],
  coverageThreshold: {
    global: {
      branches: 35,
      functions: 35,
      lines: 60,
      statements: 40,
    },
  },
  verbose: jestVerbose,
  silent: jestSilent,
  // Parallel by default (50% CPUs). Set JEST_MAX_WORKERS=1 via test:serial for low-memory runs.
  maxWorkers: jestMaxWorkers,
  // Increase heap size for tests (8GB)
  testTimeout: 60000,
  // Enable heap logging only when explicitly requested.
  logHeapUsage: jestLogHeapUsage,
};
