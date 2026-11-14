const babelTransform = require('../../scripts/jest-babel-transform.cjs');

module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['babel-jest', babelTransform.ts],
  },
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
};