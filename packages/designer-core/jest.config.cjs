module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/../contracts/src',
    '^@justybase/contracts/(.*)$': '<rootDir>/../contracts/src/$1',
  },
};
