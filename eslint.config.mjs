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
            '**/*.cjs',
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
    },
    {
        // Webview and workspace packages are being migrated to the same
        // strict baseline incrementally. Keep their current findings visible
        // without weakening the blocking core-extension rules.
        files: ['media/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
        rules: {
            '@typescript-eslint/no-unused-vars': 'warn',
            'prefer-const': 'warn',
            'no-var': 'warn',
            'no-case-declarations': 'warn',
            'no-empty': 'warn',
            'no-control-regex': 'warn',
            'no-useless-escape': 'warn',
            'no-useless-assignment': 'warn',
            '@typescript-eslint/no-unused-expressions': 'warn',
            '@typescript-eslint/no-require-imports': 'warn',
            '@typescript-eslint/triple-slash-reference': 'warn',
            'preserve-caught-error': 'warn',
        }
    }
);
