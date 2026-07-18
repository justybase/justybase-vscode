#!/usr/bin/env node

/**
 * Generates a deterministic third-party attribution file for a Marketplace
 * package. The core package is derived from bundle source maps; optional
 * packages include every production dependency shipped from their lockfile.
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const packageDir = path.resolve(process.argv[2] || process.cwd());
const manifestPath = path.join(packageDir, 'package.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function walkFiles(directory, predicate, output = []) {
  if (!existsSync(directory)) {
    return output;
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, predicate, output);
    } else if (predicate(entryPath)) {
      output.push(entryPath);
    }
  }
  return output;
}

function packageNameFromNodeModulesPath(value) {
  const normalized = value.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  const relative = markerIndex >= 0
    ? normalized.slice(markerIndex + marker.length)
    : normalized.startsWith('node_modules/')
      ? normalized.slice('node_modules/'.length)
      : '';
  if (!relative) {
    return undefined;
  }
  const segments = relative.split('/');
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

function coreDependencyDirectories() {
  const dependencyNames = new Set();
  const mapFiles = [
    ...walkFiles(path.join(packageDir, 'dist'), file => file.endsWith('.js.map')),
    ...walkFiles(path.join(packageDir, 'media'), file => /tanstack-.*\.js\.map$/.test(file)),
  ];

  for (const mapFile of mapFiles) {
    const sourceMap = readJson(mapFile);
    for (const source of sourceMap.sources || []) {
      const packageName = packageNameFromNodeModulesPath(source);
      if (packageName) {
        dependencyNames.add(packageName);
      }
    }
  }

  // Keep direct runtime dependencies represented even when esbuild removes an
  // import through tree-shaking or a platform-specific branch.
  const manifest = readJson(manifestPath);
  Object.keys(manifest.dependencies || {}).forEach(name => dependencyNames.add(name));
  dependencyNames.add('@tanstack/table-core');
  dependencyNames.add('@tanstack/virtual-core');

  return [...dependencyNames].map(name => path.join(REPOSITORY_ROOT, 'node_modules', name));
}

function optionalDependencyDirectories() {
  const lockPath = path.join(packageDir, 'package-lock.json');
  const lock = readJson(lockPath);
  return Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) =>
      packagePath.includes('node_modules/') && metadata.dev !== true && !metadata.link)
    .map(([packagePath]) => path.join(packageDir, packagePath))
    // Platform-specific optional packages that are not installed for the
    // current VSIX target are not distributed and therefore are not listed.
    .filter(dependencyDir => existsSync(path.join(dependencyDir, 'package.json')));
}

function findLicenseFile(directory) {
  const candidates = readdirSync(directory)
    .filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  return candidates.length > 0 ? path.join(directory, candidates[0]) : undefined;
}

function repositoryUrl(manifest) {
  const normalize = value => value
    .replace(/^git\+ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/^git:\/\/github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (typeof manifest.repository === 'string') {
    return normalize(manifest.repository);
  }
  if (typeof manifest.repository?.url === 'string') {
    return normalize(manifest.repository.url);
  }
  return typeof manifest.homepage === 'string' ? manifest.homepage : '';
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function inferLicenseFromText(licenseText) {
  if (/Apache License\s+Version 2\.0/i.test(licenseText)) {
    return 'Apache-2.0';
  }
  if (/Permission is hereby granted, free of charge/i.test(licenseText)) {
    return 'MIT';
  }
  if (/ISC License/i.test(licenseText)) {
    return 'ISC';
  }
  if (/Redistribution and use in source and binary forms/i.test(licenseText)) {
    return 'BSD';
  }
  return 'SEE INCLUDED LICENSE TEXT';
}

assert(existsSync(manifestPath), `Missing package manifest: ${manifestPath}`);
const extensionManifest = readJson(manifestPath);
const isCore = packageDir === REPOSITORY_ROOT;
const dependencyDirectories = isCore ? coreDependencyDirectories() : optionalDependencyDirectories();
const components = [];
const seen = new Set();

for (const dependencyDir of dependencyDirectories) {
  const dependencyManifestPath = path.join(dependencyDir, 'package.json');
  assert(existsSync(dependencyManifestPath), `Missing installed dependency metadata: ${dependencyManifestPath}`);
  const dependencyManifest = readJson(dependencyManifestPath);
  const identity = `${dependencyManifest.name}@${dependencyManifest.version}`;
  if (seen.has(identity)) {
    continue;
  }
  seen.add(identity);
  const licenseFile = findLicenseFile(dependencyDir);
  const licenseText = licenseFile ? readFileSync(licenseFile, 'utf8').trim() : undefined;
  assert(dependencyManifest.license || licenseText, `${identity} has no license metadata or license text`);
  const declaredLicense = dependencyManifest.license || inferLicenseFromText(licenseText);
  components.push({
    name: dependencyManifest.name,
    version: dependencyManifest.version,
    license: typeof declaredLicense === 'string' ? declaredLicense : JSON.stringify(declaredLicense),
    repository: repositoryUrl(dependencyManifest),
    licenseText,
  });
}

components.sort((left, right) =>
  left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const licenseGroups = new Map();
for (const component of components) {
  if (!component.licenseText) {
    continue;
  }
  const hash = createHash('sha256').update(component.licenseText).digest('hex');
  const group = licenseGroups.get(hash) || { text: component.licenseText, components: [] };
  group.components.push(`${component.name}@${component.version}`);
  licenseGroups.set(hash, group);
}

const lines = [
  '# Third-Party Notices',
  '',
  `This file lists third-party software distributed with **${extensionManifest.displayName || extensionManifest.name}**.`,
  'It is generated from the locked runtime dependency graph and packaged bundle source maps.',
  '',
  '## Components',
  '',
  '| Package | Version | License | Source |',
  '| --- | --- | --- | --- |',
];

for (const component of components) {
  const source = component.repository
    ? `[upstream](${component.repository})`
    : 'See npm package metadata';
  lines.push(`| ${escapeCell(component.name)} | ${escapeCell(component.version)} | ${escapeCell(component.license)} | ${source} |`);
}

const missingTexts = components.filter(component => !component.licenseText);
if (missingTexts.length > 0) {
  lines.push(
    '',
    '## Components without a separate license file',
    '',
    'The following published packages declare the listed SPDX license in their package metadata but do not ship a separate license text:',
    '',
    ...missingTexts.map(component => `- ${component.name}@${component.version} — ${component.license}`),
  );
}

lines.push('', '## Included license texts');
for (const group of [...licenseGroups.values()].sort((left, right) =>
  left.components[0].localeCompare(right.components[0]))) {
  lines.push(
    '',
    `### ${group.components.join(', ')}`,
    '',
    '```text',
    group.text.replaceAll('```', '``` '),
    '```',
  );
}

const outputPath = path.join(packageDir, 'THIRD_PARTY_NOTICES.md');
writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
const size = statSync(outputPath).size;
console.log(`Generated ${path.relative(REPOSITORY_ROOT, outputPath) || outputPath} for ${components.length} component(s), ${size} bytes.`);
