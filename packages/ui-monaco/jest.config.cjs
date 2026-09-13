module.exports = {
  rootDir: '.',
  testEnvironment: 'jsdom',
  preset: 'ts-jest',
  testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/../../packages/contracts/src',
    '^@justybase/ui-core$': '<rootDir>/../../packages/ui-core/src',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
