/**
 * Benchmark-specific Jest config
 *
 * Run benchmarks with:
 *   npx jest --config Benchmark/jest.config.js --verbose
 */

const path = require('path');
const projectRoot = path.resolve(__dirname, '..');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>'],
    testMatch: ['**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            tsconfig: path.join(projectRoot, 'tsconfig.json')
        }],
        '^.+\\.[mc]?js$': ['babel-jest', {
            presets: [['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }]]
        }]
    },
    moduleNameMapper: {
        '^vscode$': path.join(projectRoot, 'src/__tests__/__mocks__/vscode.ts'),
        '^@justybase/contracts$': path.join(projectRoot, 'packages/contracts/src/index.ts'),
        '^@justybase/contracts/(.*)$': path.join(projectRoot, 'packages/contracts/src/$1'),
        '^@justybase/database-utils$': path.join(projectRoot, 'packages/database-utils/src/index.ts'),
        '^@justybase/database-utils/(.*)$': path.join(projectRoot, 'packages/database-utils/src/$1'),
        '^@justybase/dialect-utils$': path.join(projectRoot, 'packages/dialect-utils/src/index.ts'),
        '^@justybase/dialect-utils/(.*)$': path.join(projectRoot, 'packages/dialect-utils/src/$1'),
        '^@justybase/designer-core$': path.join(projectRoot, 'packages/designer-core/src/index.ts'),
        '^@justybase/designer-core/(.*)$': path.join(projectRoot, 'packages/designer-core/src/$1'),
        '^@justybase/database-runtime$': path.join(projectRoot, 'packages/database-runtime/src/index.ts'),
        '^@justybase/database-runtime/(.*)$': path.join(projectRoot, 'packages/database-runtime/src/$1'),
        '^@justybase/duckdb-runtime$': path.join(projectRoot, 'packages/duckdb-runtime/src/index.ts'),
        '^@justybase/duckdb-runtime/(.*)$': path.join(projectRoot, 'packages/duckdb-runtime/src/$1'),
        '^@justybase/file-runtime$': path.join(projectRoot, 'packages/file-runtime/src/index.ts'),
        '^@justybase/file-runtime/(.*)$': path.join(projectRoot, 'packages/file-runtime/src/$1'),
        '^@justybase/metadata-core$': path.join(projectRoot, 'packages/metadata-core/src/index.ts'),
        '^@justybase/metadata-core/(.*)$': path.join(projectRoot, 'packages/metadata-core/src/$1'),
        '^@justybase/netezza-runtime$': path.join(projectRoot, 'packages/netezza-runtime/src/index.ts'),
        '^@justybase/netezza-runtime/(.*)$': path.join(projectRoot, 'packages/netezza-runtime/src/$1'),
        '^@justybase/result-core$': path.join(projectRoot, 'packages/result-core/src/index.ts'),
        '^@justybase/result-core/(.*)$': path.join(projectRoot, 'packages/result-core/src/$1'),
        '^@justybase/ui-core$': path.join(projectRoot, 'packages/ui-core/src/index.ts'),
        '^@justybase/ui-core/(.*)$': path.join(projectRoot, 'packages/ui-core/src/$1'),
        '^@justybase/ui-react$': path.join(projectRoot, 'packages/ui-react/src/index.ts'),
        '^@justybase/ui-react/(.*)$': path.join(projectRoot, 'packages/ui-react/src/$1'),
        '^@justybase/sql-core/validation$': path.join(projectRoot, 'packages/sql-core/src/validation.ts'),
        '^@justybase/sql-core$': path.join(projectRoot, 'packages/sql-core/src/index.ts'),
        '^@justybase/sql-core/(.*)$': path.join(projectRoot, 'packages/sql-core/src/$1'),
        '^@justybase/sqlite-runtime$': path.join(projectRoot, 'packages/sqlite-runtime/src/index.ts'),
        '^@justybase/sqlite-runtime/(.*)$': path.join(projectRoot, 'packages/sqlite-runtime/src/$1'),
        '^@justybase/tabular-import-runtime$': path.join(projectRoot, 'packages/tabular-import-runtime/src/index.ts'),
        '^@justybase/tabular-import-runtime/(.*)$': path.join(projectRoot, 'packages/tabular-import-runtime/src/$1'),
        '^@justybase/vscode-companion-adapter$': path.join(projectRoot, 'packages/vscode-companion-adapter/src/index.ts'),
        '^@justybase/vscode-companion-adapter/(.*)$': path.join(projectRoot, 'packages/vscode-companion-adapter/src/$1'),
        '^@chevrotain/(.+)$': path.join(projectRoot, 'node_modules/@chevrotain/$1/lib/src/api.js')
    },
    transformIgnorePatterns: [
        '/node_modules/(?!chevrotain|@chevrotain|lodash-es|hyparquet|hyparquet-writer|hyparquet-compressors|fzstd|hysnappy)/'
    ],
    // More generous timeout for benchmark iterations
    testTimeout: 120000,
    maxWorkers: 1,
    verbose: true,
};
