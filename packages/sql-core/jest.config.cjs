/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  preset: "ts-jest",
  testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
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
