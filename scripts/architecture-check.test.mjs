import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHITECTURE_CODES,
  analyzeArchitecture,
  findArchitectureDiagnostics,
} from './architecture-check.mjs';

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-architecture-'));
  for (const directory of [
    'packages/contracts/src',
    'packages/shared/src',
    'src',
    'media',
    'apps/api/src',
    'apps/web/src',
    'extensions/example/src',
  ]) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}

function writeFixture(root, relativePath, source) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${source}\n`, 'utf8');
}

function writeJsonFixture(root, relativePath, value) {
  writeFixture(root, relativePath, JSON.stringify(value, null, 2));
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function fixtureRules(overrides = {}) {
  const rules = {
    version: 1,
    layers: {
      contracts: { sources: ['packages/contracts/src'] },
      shared: { sources: ['packages/shared/src'] },
      desktop: { sources: ['src'] },
      media: { sources: ['media'] },
      api: { sources: ['apps/api/src'] },
      web: { sources: ['apps/web/src'] },
      companions: { sources: ['extensions/*/src'] },
    },
    allowedDependencies: {
      contracts: ['contracts'],
      shared: ['contracts', 'shared'],
      desktop: ['contracts', 'shared', 'desktop'],
      media: ['contracts', 'shared', 'desktop', 'media'],
      api: ['contracts', 'shared', 'api'],
      web: ['contracts', 'shared', 'web'],
      companions: ['contracts', 'shared', 'companions'],
    },
    workspaceEntryPoints: {},
    forbiddenImports: [],
    exceptions: [],
    cycleExceptions: [],
  };
  return {
    ...rules,
    ...overrides,
    layers: { ...rules.layers, ...overrides.layers },
    allowedDependencies: { ...rules.allowedDependencies, ...overrides.allowedDependencies },
  };
}

test('passes the complete repository production graph', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  assert.deepEqual(findArchitectureDiagnostics(repositoryRoot), []);
});

test('resolves relative, export, require, dynamic import, import type, aliases, workspace packages, and .js source paths', () => {
  const root = createFixture();
  try {
    writeJsonFixture(root, 'tsconfig.json', {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        baseUrl: '.',
        paths: { '@fixture/shared/*': ['packages/shared/src/*'] },
      },
    });
    writeJsonFixture(root, 'packages/contracts/package.json', { name: '@fixture/contracts', main: 'dist/index.js' });
    writeFixture(root, 'packages/contracts/src/index.ts', 'export const contract = true;');
    writeFixture(root, 'packages/shared/src/alias.ts', 'export const aliased = true;');
    writeFixture(root, 'src/relative.ts', 'export const relative = true;');
    writeFixture(root, 'src/requiree.ts', 'export const required = true;');
    writeFixture(root, 'src/dynamic.ts', 'export const dynamic = true;');
    writeFixture(root, 'src/typeOnly.ts', 'export type TypeOnly = true;');
    writeFixture(root, 'src/main.ts', `
      import { relative } from './relative.js';
      export { aliased } from '@fixture/shared/alias';
      import type { TypeOnly } from './typeOnly';
      const required = require('./requiree');
      void import('./dynamic');
      void relative;
      void required;
      const typeOnly: TypeOnly = true;
      void typeOnly;
    `);
    writeFixture(root, 'apps/api/src/main.ts', "import { contract } from '@fixture/contracts'; void contract;");

    const result = analyzeArchitecture(root, fixtureRules());
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.edges.some(edge => edge.source === 'src/main.ts' && edge.target === 'src/relative.ts'));
    assert.ok(result.edges.some(edge => edge.source === 'src/main.ts' && edge.target === 'packages/shared/src/alias.ts'));
    assert.ok(result.edges.some(edge => edge.source === 'apps/api/src/main.ts' && edge.target === 'packages/contracts/src/index.ts'));
  } finally {
    removeFixture(root);
  }
});

test('reports an import outside the configured layer direction as ARCH001', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/desktop.ts', 'export const desktop = true;');
    writeFixture(root, 'apps/api/src/main.ts', "import { desktop } from '../../../src/desktop'; void desktop;");

    const result = analyzeArchitecture(root, fixtureRules());
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.forbiddenDependency));
    assert.match(result.diagnostics.find(diagnostic => diagnostic.code === ARCHITECTURE_CODES.forbiddenDependency).message, /apps\/api\/src\/main\.ts/);
  } finally {
    removeFixture(root);
  }
});

test('assigns an overlapping source directory to the most-specific layer pattern', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'packages/shared/src/shared.ts', 'export const shared = true;');
    writeFixture(root, 'packages/contracts/src/contract.ts', "import { shared } from '../../shared/src/shared'; export const contract = shared;");
    const result = analyzeArchitecture(root, fixtureRules({
      layers: { shared: { sources: ['packages/*/src'] } },
    }));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.forbiddenDependency));
    assert.match(result.diagnostics.find(diagnostic => diagnostic.code === ARCHITECTURE_CODES.forbiddenDependency).message, /packages\/contracts\/src\/contract\.ts/);
  } finally {
    removeFixture(root);
  }
});

test('reports an unresolved internal import as ARCH002', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/main.ts', "import { missing } from './missing'; void missing;");
    const result = analyzeArchitecture(root, fixtureRules());
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.unresolvedImport));
  } finally {
    removeFixture(root);
  }
});

test('reports a new cycle as ARCH003', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/a.ts', "import { b } from './b'; export const a = b;");
    writeFixture(root, 'src/b.ts', "import { a } from './a'; export const b = a;");
    const result = analyzeArchitecture(root, fixtureRules());
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.dependencyCycle));
  } finally {
    removeFixture(root);
  }
});

test('accepts an existing cycle only with an exact fingerprinted cycle exception', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/a.ts', "import { b } from './b'; export const a = b;");
    writeFixture(root, 'src/b.ts', "import { a } from './a'; export const b = a;");
    const rules = fixtureRules();
    const baseline = analyzeArchitecture(root, rules);
    assert.equal(baseline.cycles.length, 1);
    const cycle = baseline.cycles[0];
    const anchor = baseline.edges.find(edge => cycle.nodes.includes(edge.source) && cycle.nodes.includes(edge.target));
    const allowedRules = {
      ...rules,
      cycleExceptions: [{
        source: anchor.source,
        target: anchor.target,
        nodes: cycle.nodes,
        edgeFingerprint: cycle.edgeFingerprint,
        reason: 'Fixture cycle retained during migration.',
        owner: 'Fixture owner',
      }],
    };
    const result = analyzeArchitecture(root, allowedRules);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    removeFixture(root);
  }
});

test('accepts a concrete, reasoned edge exception without accepting a layer-wide bridge', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/desktop.ts', 'export const desktop = true;');
    writeFixture(root, 'apps/api/src/main.ts', "import { desktop } from '../../../src/desktop'; void desktop;");
    const result = analyzeArchitecture(root, fixtureRules({
      exceptions: [{
        source: 'apps/api/src/main.ts',
        target: 'src/desktop.ts',
        reason: 'Fixture adapter bridge.',
        owner: 'Fixture owner',
      }],
    }));
    assert.deepEqual(result.diagnostics, []);
  } finally {
    removeFixture(root);
  }
});

test('ignores tests, mocks, dist, node_modules, declarations, and non-code assets', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/main.ts', "import './style.css'; export const ok = true;");
    writeFixture(root, 'src/style.css', 'body {}');
    writeFixture(root, 'src/__tests__/bad.test.ts', "import { missing } from '../missing'; void missing;");
    writeFixture(root, 'src/__mocks__/bad.ts', "import { missing } from '../missing'; void missing;");
    writeFixture(root, 'src/dist/bad.ts', "import { missing } from '../missing'; void missing;");
    writeFixture(root, 'src/node_modules/bad.ts', "import { missing } from '../missing'; void missing;");
    writeFixture(root, 'src/ignored.test.ts', "import { missing } from './missing'; void missing;");
    writeFixture(root, 'src/types.d.ts', "import { missing } from './missing'; export type T = typeof missing;");
    assert.deepEqual(analyzeArchitecture(root, fixtureRules()).diagnostics, []);
  } finally {
    removeFixture(root);
  }
});

test('reports malformed rules as ARCH004 and keeps the check fail-closed', () => {
  const root = createFixture();
  try {
    const result = analyzeArchitecture(root, { version: 1, layers: {} });
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.every(diagnostic => diagnostic.code === ARCHITECTURE_CODES.invalidConfiguration));
  } finally {
    removeFixture(root);
  }
});
