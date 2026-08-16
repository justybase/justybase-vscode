#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'extensions/access/package.json',
  'extensions/access/package-lock.json',
  'extensions/access/README.md',
  'extensions/access/NOTICE',
  'extensions/access/THIRD_PARTY_NOTICES.md',
  'extensions/access/src/accessConnection.ts',
  'extensions/access/src/accessDuckDbMirror.ts',
  'extensions/access/src/accessFileWriter.ts',
  'packages/access-file/package.json',
  'packages/access-file/NOTICE',
  'packages/access-file/src/accessFileSession.ts',
  'scripts/package-optional-vsix.js',
  'scripts/audit-marketplace-vsix.js',
  '.github/workflows/publish-marketplace.yml',
];

const missing = requiredFiles.filter(relative => !fs.existsSync(path.join(root, relative)));
if (missing.length > 0) {
  console.error(`Access native release snapshot is incomplete:\n${missing.map(file => `- ${file}`).join('\n')}`);
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'extensions/access/package.json'), 'utf8'));
const dependencies = packageJson.dependencies || {};
for (const dependency of ['@duckdb/node-api', 'mdb-reader']) {
  if (typeof dependencies[dependency] !== 'string') {
    throw new Error(`Access package does not declare native runtime dependency ${dependency}.`);
  }
}

const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'extensions/access/package-lock.json'), 'utf8'));
if (packageLock.lockfileVersion < 2 || !packageLock.packages) {
  throw new Error('Access package lock is not a modern npm lockfile.');
}

const forbiddenPaths = [
  'extensions/access/java-bridge',
  'extensions/access/resources/access-bridge.jar',
  'extensions/access/scripts/build-jar.js',
];
const stalePaths = forbiddenPaths.filter(relative => fs.existsSync(path.join(root, relative)));
if (stalePaths.length > 0) {
  throw new Error(`Access snapshot contains removed bridge paths: ${stalePaths.join(', ')}`);
}

console.log(`Access native release snapshot parity passed (${requiredFiles.length} required files).`);
