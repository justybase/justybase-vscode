#!/usr/bin/env node

/**
 * Runs the repository-pinned VSCE while supplying the production dependency
 * directories for optional extensions that live outside the npm workspaces.
 * This keeps the extension's own files and its runtime driver in one VSIX.
 */
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = process.cwd();
const repositoryRoot = path.resolve(__dirname, '..');
const vsceRoot = path.join(repositoryRoot, 'node_modules', '@vscode', 'vsce');

function getProductionDependencyDirectories(cwd) {
  const lockPath = path.join(cwd, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const dependencyDirectories = Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) =>
      packagePath.includes('node_modules/') && metadata.dev !== true && !metadata.link)
    .map(([packagePath]) => path.join(cwd, packagePath))
    .filter(packagePath => fs.existsSync(path.join(packagePath, 'package.json')));

  return [cwd, ...dependencyDirectories];
}

const vsceNpm = require(path.join(vsceRoot, 'out', 'npm'));
const originalGetDependencies = vsceNpm.getDependencies;

vsceNpm.getDependencies = async function getOptionalExtensionDependencies(cwd, dependencies, packagedDependencies) {
  if (path.resolve(cwd) !== extensionRoot || dependencies === 'none') {
    return originalGetDependencies(cwd, dependencies, packagedDependencies);
  }
  return getProductionDependencyDirectories(extensionRoot);
};

require(path.join(vsceRoot, 'out', 'main'))(process.argv);
