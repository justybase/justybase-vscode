const babelTransform = require('../../scripts/jest-babel-transform.cjs');

module.exports = {
  rootDir: '.',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/__tests__/**/*.test.ts', '<rootDir>/__tests__/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/../contracts/src',
    '^@justybase/ui-core$': '<rootDir>/../ui-core/src',
    '^@justybase/ui-core/(.*)$': '<rootDir>/../ui-core/src/$1',
  },
  transform: {
    '^.+\\.tsx$': ['babel-jest', babelTransform.tsx],
    '^.+\\.ts$': ['babel-jest', babelTransform.ts],
  },
  collectCoverageFrom: ['src/**/*.ts', 'src/**/*.tsx', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
};
