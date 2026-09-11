const jestSilent = process.env.JEST_SILENT !== "0";
const jestVerbose = process.env.JEST_VERBOSE === "1";
const jestLogHeapUsage = process.env.JEST_LOG_HEAP === "1";
const jestMaxWorkers = process.env.JEST_MAX_WORKERS ?? "50%";
const liveDbIgnorePatterns = require("./scripts/jestLiveDbIgnorePatterns.cjs");

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/packages/sql-core"],
  setupFiles: ["<rootDir>/src/__tests__/unitNetworkGuard.setup.ts"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: [
    "/node_modules/",
    ...liveDbIgnorePatterns,
    "/__tests__/performance/",
  ],
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  resolver: "<rootDir>/scripts/jest-media-resolver.cjs",
  transform: {
    "^.+\\/media\\/.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.media.json",
      },
    ],
    // Keep a fallback for media TSX reached through a resolver from a root
    // test (Jest may normalize the resolved path before applying the scoped
    // media pattern).
    "^.+\\.tsx$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.media.json",
      },
    ],
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: "tsconfig.json",
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
    "^@justybase/database-utils$": "<rootDir>/packages/database-utils/src/index.ts",
    "^@justybase/database-utils/(.*)$": "<rootDir>/packages/database-utils/src/$1",
    "^@justybase/dialect-utils$": "<rootDir>/packages/dialect-utils/src/index.ts",
    "^@justybase/dialect-utils/(.*)$": "<rootDir>/packages/dialect-utils/src/$1",
    "^@justybase/designer-core$": "<rootDir>/packages/designer-core/src/index.ts",
    "^@justybase/designer-core/(.*)$": "<rootDir>/packages/designer-core/src/$1",
    "^@justybase/database-runtime$": "<rootDir>/packages/database-runtime/src/index.ts",
    "^@justybase/database-runtime/(.*)$": "<rootDir>/packages/database-runtime/src/$1",
    "^@justybase/duckdb-runtime$": "<rootDir>/packages/duckdb-runtime/src/index.ts",
    "^@justybase/duckdb-runtime/(.*)$": "<rootDir>/packages/duckdb-runtime/src/$1",
    "^@justybase/file-runtime$": "<rootDir>/packages/file-runtime/src/index.ts",
    "^@justybase/file-runtime/(.*)$": "<rootDir>/packages/file-runtime/src/$1",
    "^@justybase/metadata-core$": "<rootDir>/packages/metadata-core/src/index.ts",
    "^@justybase/metadata-core/(.*)$": "<rootDir>/packages/metadata-core/src/$1",
    "^@justybase/netezza-runtime$": "<rootDir>/packages/netezza-runtime/src/index.ts",
    "^@justybase/netezza-runtime/(.*)$": "<rootDir>/packages/netezza-runtime/src/$1",
    "^@justybase/result-core$": "<rootDir>/packages/result-core/src/index.ts",
    "^@justybase/result-core/(.*)$": "<rootDir>/packages/result-core/src/$1",
    "^@justybase/ui-core$": "<rootDir>/packages/ui-core/src/index.ts",
    "^@justybase/ui-core/(.*)$": "<rootDir>/packages/ui-core/src/$1",
    "^@justybase/ui-react$": "<rootDir>/packages/ui-react/src/index.ts",
    "^@justybase/ui-react/(.*)$": "<rootDir>/packages/ui-react/src/$1",
    "^@justybase/sql-core/validation$": "<rootDir>/packages/sql-core/src/validation.ts",
    "^@justybase/sql-core$": "<rootDir>/packages/sql-core/src/index.ts",
    "^@justybase/sql-core/(.*)$": "<rootDir>/packages/sql-core/src/$1",
    "^@justybase/sqlite-runtime$": "<rootDir>/packages/sqlite-runtime/src/index.ts",
    "^@justybase/sqlite-runtime/(.*)$": "<rootDir>/packages/sqlite-runtime/src/$1",
    "^@justybase/tabular-import-runtime$": "<rootDir>/packages/tabular-import-runtime/src/index.ts",
    "^@justybase/tabular-import-runtime/(.*)$": "<rootDir>/packages/tabular-import-runtime/src/$1",
    "^@justybase/vscode-companion-adapter$": "<rootDir>/packages/vscode-companion-adapter/src/index.ts",
    "^@justybase/vscode-companion-adapter/(.*)$": "<rootDir>/packages/vscode-companion-adapter/src/$1",
    "^(.*/media/.+)\\.js$": "$1",
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
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/__tests__/**",
    "packages/sql-core/src/**/*.ts",
    "!packages/sql-core/src/**/*.d.ts",
    "!packages/access-file/src/jet/JetIndexCodesData.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "json-summary", "lcov"],
  coverageThreshold: {
    global: {
      branches: 58,
      functions: 76,
      lines: 72,
      statements: 71,
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
