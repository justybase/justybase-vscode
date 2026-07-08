import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: [
            'dist/**',
            'driver/**',
            'node_modules/**',
            'ExcelHelpersTs/**',
            '**/*.js',
            'src/__tests__/__mocks__/**'
        ]
    },
    {
        files: ['src/**/*.ts', 'extensions/**/src/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-require-imports': 'off',
            'no-case-declarations': 'off',
            'prefer-const': 'warn'
        }
    },
    {
        files: [
            'src/core/batchQueryExecutor.ts',
            'src/core/connectionManager.ts',
            'src/core/queryBatchExecutor.ts',
            'src/core/queryRunnerHelpers.ts',
            'src/core/streaming/StreamingManager.ts'
        ],
        rules: {
            'no-console': 'error'
        }
    }
);
