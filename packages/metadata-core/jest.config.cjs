const babelTransform = require('../../scripts/jest-babel-transform.cjs');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['babel-jest', babelTransform.ts],
  },
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
};
