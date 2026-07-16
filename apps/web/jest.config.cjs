module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  moduleNameMapper: { '^@justybase/contracts$': '<rootDir>/../../packages/contracts/src' },
};
