#!/usr/bin/env node

/**
 * Deterministic workspace build entry point.
 *
 * npm workspaces do not know that several package builds write into the same
 * repository checkout. This small graph makes the order explicit and uses a
 * process lock around the whole graph, so two developers/CI jobs cannot
 * interleave writes to dist directories.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const lockPath = path.join(os.tmpdir(), 'justybase-workspace-build.lock');
const lockMaxAgeMs = 30 * 60 * 1000;
const lockPollMs = 200;

const nodes = {
  contracts: { packageName: '@justybase/contracts' },
  'sql-core': { packageName: '@justybase/sql-core', dependencies: ['contracts'] },
  'dialect-utils': { packageName: '@justybase/dialect-utils', dependencies: ['contracts', 'sql-core'] },
  'designer-core': { packageName: '@justybase/designer-core', dependencies: ['contracts', 'dialect-utils'] },
  'metadata-core': { packageName: '@justybase/metadata-core' },
  'result-core': { packageName: '@justybase/result-core' },
  'api-client': { packageName: '@justybase/api-client', dependencies: ['contracts'] },
  'ui-core': { packageName: '@justybase/ui-core', dependencies: ['contracts'] },
  'ui-monaco': { packageName: '@justybase/ui-monaco', dependencies: ['contracts', 'ui-core'] },
  'ui-react': { packageName: '@justybase/ui-react', dependencies: ['contracts', 'dialect-utils', 'designer-core', 'ui-core'] },
  'netezza-runtime': { packageName: '@justybase/netezza-runtime', dependencies: ['contracts'] },
  'duckdb-runtime': { packageName: '@justybase/duckdb-runtime', dependencies: ['contracts'] },
  'database-utils': { packageName: '@justybase/database-utils', dependencies: ['contracts'] },
  'file-runtime': { packageName: '@justybase/file-runtime', dependencies: ['contracts'] },
  'tabular-import-runtime': { packageName: '@justybase/tabular-import-runtime', dependencies: ['database-utils', 'dialect-utils'] },
  'vscode-companion-adapter': { packageName: '@justybase/vscode-companion-adapter', dependencies: ['contracts'] },
  'database-runtime': { packageName: '@justybase/database-runtime', dependencies: ['contracts', 'designer-core', 'netezza-runtime'] },
  'sqlite-runtime': { packageName: '@justybase/sqlite-runtime', dependencies: ['contracts'] },
  'web-api': { packageName: '@justybase/web-api', dependencies: ['contracts', 'database-runtime', 'dialect-utils', 'designer-core', 'duckdb-runtime', 'metadata-core', 'netezza-runtime', 'sqlite-runtime', 'sql-core'] },
  // Vite is run once at the end so --test can be applied without rebuilding
  // the dependency graph a second time.
  web: { packageName: '@justybase/web', script: null, dependencies: ['api-client', 'contracts', 'designer-core', 'dialect-utils', 'result-core', 'ui-core', 'ui-monaco', 'ui-react'] },
  'electron-bundle': { packageName: '@justybase/electron-shell', script: 'build:bundle', dependencies: ['api-client', 'contracts', 'ui-core', 'ui-monaco', 'ui-react', 'web-api'] },
};

const targets = {
  api: ['web-api'],
  web: ['web'],
  electron: ['electron-bundle'],
  all: ['web-api', 'web', 'electron-bundle'],
  shared: ['api-client', 'database-utils', 'file-runtime', 'dialect-utils', 'tabular-import-runtime', 'vscode-companion-adapter', 'ui-core', 'ui-monaco', 'ui-react'],
  desktop: ['metadata-core', 'result-core', 'designer-core', 'sql-core', 'ui-core', 'ui-react', 'api-client', 'database-utils', 'file-runtime', 'tabular-import-runtime', 'vscode-companion-adapter', 'duckdb-runtime', 'netezza-runtime', 'database-runtime', 'sqlite-runtime'],
};

function usage() {
  console.error('Usage: node scripts/workspace-build-graph.mjs <api|web|electron|all|shared|desktop> [--test] [--minify] [--watch]');
  process.exit(2);
}

function parseArguments() {
  const [target, ...flags] = process.argv.slice(2);
  if (!target || !(target in targets)) usage();
  return {
    target,
    test: flags.includes('--test'),
    minify: flags.includes('--minify'),
    watch: flags.includes('--watch'),
  };
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function acquireBuildLock() {
  const token = randomUUID();
  while (true) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      const record = { pid: process.pid, startedAt: Date.now(), token };
      fs.writeFileSync(descriptor, JSON.stringify(record));
      fs.closeSync(descriptor);
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readLock();
      const stale = !current
        || (typeof current.startedAt === 'number' && Date.now() - current.startedAt > lockMaxAgeMs)
        || !processIsAlive(current.pid);
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      await sleep(lockPollMs);
    }
  }
}

function releaseBuildLock(token) {
  const current = readLock();
  if (current?.token !== token) return;
  try { fs.unlinkSync(lockPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function npmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) return { command: process.execPath, prefix: [npmExecPath] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

function runCommand(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'unknown'}.`);
}

function runWorkspace(nodeName, options) {
  const node = nodes[nodeName];
  if (!node) throw new Error(`Unknown build graph node: ${nodeName}`);
  if (node.script === null) return;
  const npm = npmInvocation();
  const args = [...npm.prefix, 'run', node.script ?? 'build', '--workspace', node.packageName];
  runCommand(npm.command, args, options.environment);
}

function runRootDesktopBundle({ minify, watch }) {
  const args = ['esbuild.js'];
  if (minify) args.push('--minify');
  if (watch) args.push('--watch');
  runCommand(process.execPath, args);
}

function collectNodes(rootNames) {
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Cycle in workspace build graph at ${name}.`);
    visiting.add(name);
    for (const dependency of nodes[name]?.dependencies ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  }
  for (const rootName of rootNames) visit(rootName);
  return ordered;
}

async function main() {
  const options = parseArguments();
  const lockToken = await acquireBuildLock();
  try {
    const environment = { ...process.env };
    if (options.test) environment.VITE_ENABLE_TEST_LOGIN = '1';
    const nodeNames = collectNodes(targets[options.target]);
    console.log(`[workspace-build] ${options.target}: ${nodeNames.join(' -> ')}`);
    for (const nodeName of nodeNames) runWorkspace(nodeName, { environment });
    if (options.target === 'web' || options.target === 'all') {
      const npm = npmInvocation();
      const args = [...npm.prefix, 'run', 'build', '--workspace', '@justybase/web'];
      if (options.test) args.push('--', '--mode', 'test');
      runCommand(npm.command, args, environment);
    }
    if (options.target === 'desktop') runRootDesktopBundle(options);
  } finally {
    releaseBuildLock(lockToken);
  }
}

main().catch(error => {
  console.error(`[workspace-build] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
