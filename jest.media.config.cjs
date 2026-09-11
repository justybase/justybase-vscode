module.exports = {
  rootDir: '.',
  testEnvironment: 'jsdom',
  preset: 'ts-jest',
  roots: ['<rootDir>/media'],
  setupFiles: ['<rootDir>/media/__tests__/setup.ts'],
  testMatch: ['<rootDir>/media/**/__tests__/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  resolver: '<rootDir>/scripts/jest-media-resolver.cjs',
  transform: {
    '^.+\\.[cm]?[jt]sx?$': ['ts-jest', { tsconfig: 'tsconfig.media.json' }],
  },
  moduleNameMapper: {
    '^@justybase/contracts$': '<rootDir>/packages/contracts/src/index.ts',
    '^@justybase/ui-core$': '<rootDir>/packages/ui-core/src/index.ts',
    '^@justybase/ui-core/(.*)$': '<rootDir>/packages/ui-core/src/$1',
    '^@justybase/ui-react$': '<rootDir>/packages/ui-react/src/index.ts',
    '^@justybase/ui-react/(.*)$': '<rootDir>/packages/ui-react/src/$1',
  },
  collectCoverageFrom: [
    'media/resultPanel/sharedView.tsx',
    '!media/**/*.d.ts',
  ],
  coverageDirectory: 'coverage/media',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  testTimeout: 60000,
};
