module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/../../packages/contracts/src',
    '^@justybase/designer-core$': '<rootDir>/../../packages/designer-core/src',
    '^@justybase/designer-core/(.*)$': '<rootDir>/../../packages/designer-core/src/$1',
    '^@justybase/result-core$': '<rootDir>/../../packages/result-core/src',
    '^@justybase/result-core/(.*)$': '<rootDir>/../../packages/result-core/src/$1',
  },
};
