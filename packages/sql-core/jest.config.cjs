/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  preset: "ts-jest",
  testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^@justybase/contracts$": "<rootDir>/../contracts/src/index.ts",
    "^@justybase/contracts/(.*)$": "<rootDir>/../contracts/src/$1",
  },
};
