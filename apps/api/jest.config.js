module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/../../packages/contracts/src',
    '^@justybase/designer-core$': '<rootDir>/../../packages/designer-core/src',
    '^@justybase/designer-core/(.*)$': '<rootDir>/../../packages/designer-core/src/$1',
  },
};
