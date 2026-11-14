/**
 * Minimal `jest.mock` hoisting without `babel-plugin-jest-hoist`'s scope
 * validation.
 *
 * The test suite was written against `ts-jest`, whose hoisting transformer sorts
 * the `@jest/globals` import, `jest.mock` calls, and the remaining statements so
 * that mocks are registered before the modules they replace. `babel-preset-jest`
 * rejects factories that reference module-scope helpers ("Invalid variable
 * access"), and Babel moves every import to the top, so the helpers a factory
 * closes over must move with the mock.
 *
 * This plugin runs in Babel's `post` hook, after the CommonJS transform:
 * - top-level `jest.mock`/`unmock`/automock calls are moved above the imports;
 * - top-level helpers that those factories reference (transitively) are moved
 *   with them, in source order.
 *
 * `@jest/globals` must keep its own `require` first, so calls that use it are
 * inserted after it.
 */
const HOISTED_METHODS = new Set([
    'mock',
    'unmock',
    'enableAutomock',
    'disableAutomock',
    'deepUnmock',
]);

const SKIPPED_KEYS = new Set([
    'loc',
    'start',
    'end',
    'extra',
    'range',
    'leadingComments',
    'trailingComments',
    'innerComments',
]);

function isJestObject(node) {
    if (!node) return false;
    if (node.type === 'Identifier') return node.name === 'jest';
    // Babel rewrites `jest` imported from `@jest/globals` to `_jestGlobals.jest`.
    return node.type === 'MemberExpression'
        && !node.computed
        && node.property.type === 'Identifier'
        && node.property.name === 'jest';
}

function isHoistedJestCall(node) {
    if (!node || node.type !== 'CallExpression') return false;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return false;
    if (!isJestObject(callee.object)) return false;
    return callee.property.type === 'Identifier' && HOISTED_METHODS.has(callee.property.name);
}

function isJestGlobalsRequire(statement) {
    if (statement.type !== 'VariableDeclaration') return false;
    return statement.declarations.some((declaration) => {
        const init = declaration.init;
        return init
            && init.type === 'CallExpression'
            && init.callee.type === 'Identifier'
            && init.callee.name === 'require'
            && init.arguments.length === 1
            && init.arguments[0].type === 'StringLiteral'
            && init.arguments[0].value === '@jest/globals';
    });
}

/**
 * Collect identifiers in reference positions. Property keys, member property
 * names, and binding identifiers are not references.
 */
function collectIdentifiers(node, names) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
        node.forEach((child) => collectIdentifiers(child, names));
        return;
    }

    switch (node.type) {
        case 'Identifier':
            names.add(node.name);
            return;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            collectIdentifiers(node.object, names);
            if (node.computed) collectIdentifiers(node.property, names);
            return;
        case 'ObjectProperty':
            if (node.computed) collectIdentifiers(node.key, names);
            collectIdentifiers(node.value, names);
            return;
        case 'ObjectMethod':
        case 'ClassMethod':
        case 'ClassPrivateMethod':
            if (node.computed) collectIdentifiers(node.key, names);
            collectIdentifiers(node.body, names);
            return;
        case 'ClassProperty':
        case 'ClassPrivateProperty':
            if (node.computed) collectIdentifiers(node.key, names);
            collectIdentifiers(node.value, names);
            return;
        case 'VariableDeclarator':
            collectIdentifiers(node.init, names);
            return;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            collectIdentifiers(node.body, names);
            return;
        default:
            for (const [key, value] of Object.entries(node)) {
                if (SKIPPED_KEYS.has(key)) continue;
                collectIdentifiers(value, names);
            }
    }
}

module.exports = function jestHoistPlugin() {
    return {
        name: 'justybase-jest-hoist',
        post({ path: program }) {
            const body = program.node.body;
            const hoistedCalls = [];
            const referenced = new Set();

            for (const statement of body) {
                if (
                    statement.type !== 'ExpressionStatement'
                    || !isHoistedJestCall(statement.expression)
                ) {
                    continue;
                }

                hoistedCalls.push(statement);
                const factory = statement.expression.arguments[1];
                if (
                    factory
                    && (factory.type === 'FunctionExpression' || factory.type === 'ArrowFunctionExpression')
                ) {
                    collectIdentifiers(factory.body, referenced);
                }
            }

            if (hoistedCalls.length === 0) return;

            // Move the top-level helpers the factories close over. Repeat until
            // the closure is stable so helpers that depend on other helpers move
            // too. Source order is preserved afterwards.
            const hoistedVars = new Set();
            let changed = true;

            while (changed) {
                changed = false;
                program.traverse({
                    VariableDeclarator(variablePath) {
                        const { id, init } = variablePath.node;
                        if (!init || id.type !== 'Identifier') return;
                        if (!referenced.has(id.name)) return;
                        if (!variablePath.parentPath.parentPath.isProgram()) return;

                        const declaration = variablePath.parentPath.node;
                        if (hoistedVars.has(declaration)) return;

                        hoistedVars.add(declaration);
                        collectIdentifiers(init, referenced);
                        changed = true;
                    },
                });
            }

            const remaining = [];
            body.forEach((statement, index) => {
                if (hoistedCalls.includes(statement) || hoistedVars.has(statement)) return;
                remaining.push({ statement, index });
            });

            const hoistedVarList = body.filter((statement) => hoistedVars.has(statement));

            // Insert after the `@jest/globals` require when present, otherwise at
            // the very top (program directives live outside `body`, so they keep
            // running first).
            let globalsIndex = -1;
            body.forEach((statement, index) => {
                if (isJestGlobalsRequire(statement)) globalsIndex = index;
            });
            const insertionPoint = globalsIndex + 1;
            const insertionIndex = remaining.filter((entry) => entry.index < insertionPoint).length;

            program.node.body = [
                ...remaining.slice(0, insertionIndex).map((entry) => entry.statement),
                ...hoistedVarList,
                ...hoistedCalls,
                ...remaining.slice(insertionIndex).map((entry) => entry.statement),
            ];
        },
    };
};
