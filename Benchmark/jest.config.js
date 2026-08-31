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
        '^@chevrotain/(.+)$': path.join(projectRoot, 'node_modules/@chevrotain/$1/lib/src/api.js')
    },
    transformIgnorePatterns: [
        '/node_modules/(?!chevrotain|@chevrotain|lodash-es)/'
    ],
    // More generous timeout for benchmark iterations
    testTimeout: 120000,
    maxWorkers: 1,
    verbose: true,
};
