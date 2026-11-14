/**
 * Shared Jest transform options.
 *
 * Jest transpiles TypeScript with Babel instead of the TypeScript compiler API,
 * so the test runner keeps working after the project moved type checking to
 * TypeScript 7. Type checking is a separate gate (`npm run check-types`), which
 * already covers `src/**` including the test files.
 *
 * Babel is used instead of `@swc/jest` because SWC emits CommonJS exports as
 * non-configurable getters, which breaks `jest.spyOn` on module namespaces.
 * Babel emits plain assignments, matching the previous `ts-jest` behaviour.
 *
 * Two compatibility plugins keep Babel's emit aligned with the project's
 * TypeScript configuration:
 * - `jest-erase-type-fields-plugin` removes `field!: T` declarations, which
 *   TypeScript erases for `useDefineForClassFields: false`.
 * - `jest-hoist-plugin` hoists `jest.mock` calls without the scope validation in
 *   `babel-preset-jest`, which rejects factories used by the existing tests.
 */
const commonJsPreset = [
    '@babel/preset-env',
    {
        targets: { node: 'current' },
        modules: 'commonjs',
        // Loose CommonJS emits `exports.foo = ...` assignments instead of
        // non-configurable getters, which keeps `jest.spyOn` working on module
        // namespaces (matching the previous `ts-jest` output).
        loose: true,
    },
];

const typeScriptPreset = [
    '@babel/preset-typescript',
    {
        allowDeclareFields: true,
    },
];

const tsxPreset = [
    '@babel/preset-typescript',
    {
        allExtensions: true,
        isTSX: true,
        allowDeclareFields: true,
    },
];

// Jest serialises transformer options for worker processes, so plugins are
// referenced by path instead of by function.
const plugins = [
    require.resolve('./jest-erase-type-fields-plugin.cjs'),
    require.resolve('./jest-hoist-plugin.cjs'),
];

const assumptions = {
    // Match TypeScript's `useDefineForClassFields: false` emit for the project's
    // ES2020 target: fields are assigned, not defined.
    setPublicClassFields: true,
};

module.exports = {
    ts: {
        assumptions,
        excludeJestPreset: true,
        plugins,
        presets: [commonJsPreset, typeScriptPreset],
        sourceMaps: true,
    },
    tsx: {
        assumptions,
        excludeJestPreset: true,
        plugins,
        presets: [
            commonJsPreset,
            tsxPreset,
            [
                '@babel/preset-react',
                {
                    runtime: 'automatic',
                },
            ],
        ],
        sourceMaps: true,
    },
};
