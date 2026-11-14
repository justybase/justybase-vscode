const babelTransform = require('../../scripts/jest-babel-transform.cjs');

module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['babel-jest', babelTransform.ts],
  },
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/../contracts/src',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
};
