const babelTransform = require('../../scripts/jest-babel-transform.cjs');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["babel-jest", babelTransform.ts],
    "^.+\\.[mc]?js$": [
      "babel-jest",
      {
        presets: [["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }]],
      },
    ],
  },
  transformIgnorePatterns: ["/node_modules/(?!chevrotain|@chevrotain)/"],
  moduleNameMapper: {
    "^@justybase/contracts$": "<rootDir>/../contracts/src/index.ts",
    "^@justybase/contracts/(.*)$": "<rootDir>/../contracts/src/$1",
    "^@chevrotain/(.+)$": "<rootDir>/../../node_modules/@chevrotain/$1/lib/src/api.js",
  },
};
