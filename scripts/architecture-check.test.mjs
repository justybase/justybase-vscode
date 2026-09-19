import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHITECTURE_CODES,
  analyzeArchitecture,
  createArchitectureReport,
  findArchitectureDiagnostics,
  loadArchitectureRules,
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
      void import('./dynamic', { with: { type: 'json' } });
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

test('scans import-equals and attributed dynamic imports', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/dynamic.ts', 'export const dynamic = true;');
    writeFixture(root, 'src/import-equals.ts', "import vscode = require('vscode'); void vscode;");
    writeFixture(root, 'src/main.ts', "void import('./dynamic', { with: { type: 'json' } });");
    const result = analyzeArchitecture(root, fixtureRules({
      forbiddenImports: [{ layer: 'desktop', specifier: '^vscode$' }],
    }));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.forbiddenDependency
      && diagnostic.specifier === 'vscode'));
    assert.ok(result.edges.some(edge => edge.source === 'src/main.ts'
      && edge.target === 'src/dynamic.ts'
      && edge.kind === 'dynamic-import'));
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

test('reports a TypeScript source outside configured production roots as ARCH002', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'tools/helper.ts', 'export const helper = true;');
    writeFixture(root, 'src/main.ts', "import { helper } from '../tools/helper'; void helper;");
    const result = analyzeArchitecture(root, fixtureRules());
    const diagnostic = result.diagnostics.find(candidate => candidate.code === ARCHITECTURE_CODES.unresolvedImport);
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /outside the configured production graph: tools\/helper\.ts/);
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
        removeWhen: 'The fixture bridge is removed.',
      }],
    };
    const result = analyzeArchitecture(root, allowedRules);
    assert.deepEqual(result.diagnostics, []);
    writeFixture(root, 'src/b.ts', "import { a } from './a'; import './b'; export const b = a;");
    assert.ok(analyzeArchitecture(root, allowedRules).diagnostics.some(d => d.code === ARCHITECTURE_CODES.dependencyCycle));
  } finally {
    removeFixture(root);
  }
});

test('does not match a cycle exception anchor from another strongly connected component', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/a.ts', "import { b } from './b'; export const a = b;");
    writeFixture(root, 'src/b.ts', "import { a } from './a'; export const b = a;");
    writeFixture(root, 'src/c.ts', "import { d } from './d'; export const c = d;");
    writeFixture(root, 'src/d.ts', "import { c } from './c'; export const d = c;");
    const rules = fixtureRules();
    const baseline = analyzeArchitecture(root, rules);
    const firstCycle = baseline.cycles.find(cycle => cycle.nodes.includes('src/a.ts'));
    const otherCycleAnchor = baseline.edges.find(edge => edge.source === 'src/c.ts' && edge.target === 'src/d.ts');
    assert.ok(firstCycle);
    assert.ok(otherCycleAnchor);
    const result = analyzeArchitecture(root, {
      ...rules,
      cycleExceptions: [{
        source: otherCycleAnchor.source,
        target: otherCycleAnchor.target,
        nodes: firstCycle.nodes,
        edgeFingerprint: firstCycle.edgeFingerprint,
        reason: 'Incorrectly scoped fixture anchor.',
        owner: 'Fixture owner',
        removeWhen: 'The fixture bridge is removed.',
      }],
    });
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.dependencyCycle
      && diagnostic.nodes?.includes('src/a.ts')));
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
        removeWhen: 'The fixture bridge is removed.',
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

test('rejects malformed forbidden-import regular expressions as ARCH004', () => {
  const root = createFixture();
  try {
    const result = analyzeArchitecture(root, fixtureRules({ forbiddenImports: [{ specifier: '[' }] }));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.invalidConfiguration));
  } finally {
    removeFixture(root);
  }
});

test('rejects malformed nested tsconfig diagnostics as ARCH004', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'apps/api/tsconfig.json', '{ "compilerOptions": { "module": "not-a-module" } }');
    writeFixture(root, 'apps/api/src/main.ts', 'export const main = true;');
    const result = analyzeArchitecture(root, fixtureRules());
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === ARCHITECTURE_CODES.invalidConfiguration));
  } finally {
    removeFixture(root);
  }
});

test('pure packages reject platform modules, unknown drivers and runtime packages through every import form', () => {
  const root = createFixture();
  try {
    const { rules: repositoryRules } = loadArchitectureRules(path.resolve(import.meta.dirname, '..'));
    writeFixture(root, 'packages/shared/src/runtime.ts', "import 'node:fs'; export const runtime = true;");
    writeFixture(root, 'packages/contracts/src/index.ts', `
      import 'fs';
      export * from 'node:path';
      import type { ReactNode } from 'react';
      void import('react-dom/client');
      const driver = require('mysql2/promise');
      import editor = require('vscode');
      type Main = import('electron').App;
      import 'some-future-database-driver';
      import { runtime } from '../../shared/src/runtime';
    `);
    const result = analyzeArchitecture(root, fixtureRules({
      pureSources: repositoryRules.pureSources,
      pureExternalImports: repositoryRules.pureExternalImports,
    }));
    assert.equal(result.diagnostics.length, 9);
    assert.ok(result.diagnostics.every(d => d.code === ARCHITECTURE_CODES.forbiddenDependency));
    assert.ok(result.diagnostics.some(d => d.target === 'packages/shared/src/runtime.ts'));
    assert.ok(result.diagnostics.every(d => d.source === 'packages/contracts/src/index.ts'));
  } finally {
    removeFixture(root);
  }
});

test('a pure shared engine cannot import a Node runtime even through a workspace alias', () => {
  const root = createFixture();
  try {
    writeJsonFixture(root, 'packages/shared/package.json', { name: '@fixture/runtime', main: 'dist/index.js' });
    writeFixture(root, 'packages/shared/src/index.ts', "import 'node:fs'; export const runtime = true;");
    writeFixture(root, 'packages/result-core/src/index.ts', "export { runtime } from '@fixture/runtime';");
    const result = analyzeArchitecture(root, fixtureRules({
      layers: { shared: { sources: ['packages/*/src'] } },
      pureSources: ['packages/*-core/src/**'],
    }));
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].code, ARCHITECTURE_CODES.forbiddenDependency);
  } finally {
    removeFixture(root);
  }
});

test('new shared-to-desktop, web-to-desktop and cross-companion bridges fail', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/index.ts', 'export const value = true;');
    writeFixture(root, 'extensions/other/src/index.ts', 'export const other = true;');
    writeFixture(root, 'extensions/example/src/index.ts', "export { other } from '../../other/src';");
    writeFixture(root, 'packages/shared/src/index.ts', "export { value } from '../../../src';");
    writeFixture(root, 'apps/web/src/index.ts', "export { value } from '../../../src';");
    const result = analyzeArchitecture(root, fixtureRules());
    assert.equal(result.diagnostics.length, 3);
    assert.ok(result.diagnostics.every(d => d.code === ARCHITECTURE_CODES.forbiddenDependency));
  } finally {
    removeFixture(root);
  }
});

test('exceptions require removal conditions and exact paths', () => {
  const root = createFixture();
  try {
    for (const exception of [
      { source: 'src/a.ts', target: 'apps/api/src/a.ts', reason: 'Bridge', owner: 'Owner' },
      { source: 'src/**', target: 'apps/api/src/a.ts', reason: 'Bridge', owner: 'Owner', removeWhen: 'Migration passes' },
    ]) {
      const result = analyzeArchitecture(root, fixtureRules({ exceptions: [exception] }));
      assert.ok(result.diagnostics.some(d => d.code === ARCHITECTURE_CODES.invalidConfiguration));
    }
  } finally {
    removeFixture(root);
  }
});

test('a legacy pure external exception cannot authorize another source and must be removed when stale', () => {
  const root = createFixture();
  try {
    const rules = fixtureRules({
      pureSources: ['packages/contracts/src/**'],
      pureExternalExceptions: [{ source: 'packages/contracts/src/a.ts', target: 'vscode-languageserver/node',
        reason: 'Legacy protocol entry', owner: 'SQL owner', removeWhen: 'Browser entry replaces it' }],
    });
    writeFixture(root, 'packages/contracts/src/a.ts', "import 'vscode-languageserver/node';");
    assert.deepEqual(analyzeArchitecture(root, rules).diagnostics, []);
    writeFixture(root, 'packages/contracts/src/b.ts', "import 'vscode-languageserver/node';");
    assert.equal(analyzeArchitecture(root, rules).diagnostics[0].code, ARCHITECTURE_CODES.forbiddenDependency);
    writeFixture(root, 'packages/contracts/src/a.ts', 'export {};');
    assert.ok(analyzeArchitecture(root, rules).diagnostics.some(d => d.code === ARCHITECTURE_CODES.invalidConfiguration));
  } finally {
    removeFixture(root);
  }
});

test('pure engines can use approved portable libraries and other pure packages', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'packages/contracts/src/index.ts', 'export const value = true;');
    writeFixture(root, 'packages/shared/src/index.ts', "import 'chevrotain'; export { value } from '../../contracts/src';");
    const rules = fixtureRules({
      pureSources: ['packages/*/src/**'], pureExternalImports: ['chevrotain'],
    });
    const result = analyzeArchitecture(root, rules);
    assert.deepEqual(result.diagnostics, []);
    const report = createArchitectureReport(result);
    assert.equal(report.reportVersion, 1);
    assert.deepEqual(report.layerEdges, { 'shared -> contracts': 1 });
    assert.deepEqual(report.edges, result.edges);
    assert.deepEqual(report.rules, result.rules);
    assert.deepEqual(report.cycles, result.cycles);
  } finally {
    removeFixture(root);
  }
});

test('package boundaries reject undeclared cross-package imports even in the same layer', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'packages/first-core/src/index.ts', "export { value } from '../../second-core/src';");
    writeFixture(root, 'packages/second-core/src/index.ts', 'export const value = 1;');
    const rules = fixtureRules({
      layers: { shared: { sources: ['packages/*/src'] } },
      pureSources: ['packages/*-core/src/**'],
      packageDependencies: { 'packages/first-core': [], 'packages/second-core': [] },
    });
    const rejected = analyzeArchitecture(root, rules);
    assert.equal(rejected.diagnostics.length, 1);
    assert.equal(rejected.diagnostics[0].code, ARCHITECTURE_CODES.forbiddenDependency);
    rules.packageDependencies['packages/first-core'].push('packages/second-core');
    assert.deepEqual(analyzeArchitecture(root, rules).diagnostics, []);
    writeFixture(root, 'packages/unregistered/src/index.ts', 'export const missing = true;');
    assert.ok(analyzeArchitecture(root, rules).diagnostics.some(d => d.code === ARCHITECTURE_CODES.invalidConfiguration));
  } finally {
    removeFixture(root);
  }
});

test('browser boundaries follow value imports through facades and reject unapproved external modules', () => {
  const root = createFixture();
  try {
    writeJsonFixture(root, 'tsconfig.json', { compilerOptions: { paths: { '@runtime': ['./packages/shared/src/index.ts'] } } });
    writeFixture(root, 'apps/web/src/index.ts', "export { value } from './facade';");
    writeFixture(root, 'apps/web/src/facade.ts', "export { value } from '@runtime';");
    writeFixture(root, 'packages/shared/src/index.ts', "import 'node:fs'; import 'new-database-driver'; export const value = 1;");
    const result = analyzeArchitecture(root, fixtureRules({ browserSources: ['apps/web/src/**'] }));
    assert.equal(result.diagnostics.length, 3);
    assert.ok(result.diagnostics.every(d => d.code === ARCHITECTURE_CODES.forbiddenDependency));
    assert.ok(result.diagnostics.some(d => d.target === 'packages/shared/src/index.ts'));
    assert.ok(result.diagnostics.some(d => d.specifier === 'node:fs'));
    assert.ok(result.diagnostics.some(d => d.specifier === 'new-database-driver'));
  } finally {
    removeFixture(root);
  }
});

test('browser graph ignores erased imports but detects a value import beside a type import', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'src/host.ts', "import 'node:fs'; export interface Host {} export const value = 1;");
    writeFixture(root, 'media/index.ts', `
      import type { Host } from '../src/host';
      import { type Host as Other } from '../src/host';
      export type { Host } from '../src/host';
      export { type Host as Third } from '../src/host';
      type Handle = import('../src/host').Host;
    `);
    const rules = fixtureRules({ browserSources: ['media/**'] });
    assert.deepEqual(analyzeArchitecture(root, rules).diagnostics, []);
    fs.appendFileSync(path.join(root, 'media/index.ts'), "\nexport { value } from '../src/host';\n");
    const result = analyzeArchitecture(root, rules);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].specifier, 'node:fs');
  } finally {
    removeFixture(root);
  }
});

test('browser approvals allow portable libraries but cannot approve Node builtins', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'media/index.ts', "import 'react'; void import('fs');");
    const result = analyzeArchitecture(root, fixtureRules({
      browserSources: ['media/**'], browserExternalImports: ['react', 'fs'],
    }));
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].specifier, 'fs');
  } finally {
    removeFixture(root);
  }
});

test('invalid browser and package boundary configuration fails closed', () => {
  const root = createFixture();
  try {
    const result = analyzeArchitecture(root, fixtureRules({
      browserSources: 'media/**', browserExternalImports: [null],
      packageDependencies: { 'packages/*': ['missing'], 'packages/broken': null },
    }));
    assert.equal(result.diagnostics.length, 5);
    assert.ok(result.diagnostics.every(d => d.code === ARCHITECTURE_CODES.invalidConfiguration));
  } finally {
    removeFixture(root);
  }
});

test('report CLI emits JSON, preserves the baseline and fails on violations', () => {
  const root = createFixture();
  try {
    const rules = fixtureRules();
    writeJsonFixture(root, 'quality/architecture-rules.json', rules);
    writeFixture(root, 'src/index.ts', 'export const value = true;');
    const runReport = () => spawnSync(process.execPath,
      [path.join(import.meta.dirname, 'architecture-check.mjs'), '--report'],
      { cwd: root, encoding: 'utf8' });
    const passing = runReport();
    assert.ifError(passing.error);
    assert.equal(passing.status, 0, passing.stderr);
    assert.ok(passing.stdout.trim(), `Report CLI returned no JSON (stderr: ${passing.stderr}, signal: ${passing.signal}).`);
    assert.equal(JSON.parse(passing.stdout).reportVersion, 1);
    writeFixture(root, 'apps/web/src/index.ts', "export { value } from '../../../src';");
    const failing = runReport();
    assert.ifError(failing.error);
    assert.equal(failing.status, 1, failing.stderr);
    assert.equal(JSON.parse(failing.stdout).diagnostics[0].code, ARCHITECTURE_CODES.forbiddenDependency);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'quality/architecture-rules.json'), 'utf8')), rules);
  } finally {
    removeFixture(root);
  }
});
