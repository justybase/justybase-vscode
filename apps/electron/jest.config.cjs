module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/tests/**/*.test.ts', '<rootDir>/tests/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^.+\\.css$': '<rootDir>/tests/styleStub.cjs',
    '^@justybase/contracts$': '<rootDir>/../../packages/contracts/src',
    '^@justybase/ui-core$': '<rootDir>/../../packages/ui-core/src',
    '^@justybase/ui-react$': '<rootDir>/../../packages/ui-react/src',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts', 'src/**/*.tsx', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
};
