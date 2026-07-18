#!/usr/bin/env node

/**
 * Audits final Marketplace artifacts, not just build configuration. The audit
 * treats extension-owned code more strictly than traceable npm dependencies:
 * first-party JavaScript must be readable and mapped when it is a large bundle,
 * while packaged dependency code and native assets must have package metadata.
 */
const { createHash } = require('node:crypto');
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

const [inputDir = 'artifacts', outputDir = 'marketplace-review'] = process.argv.slice(2);
const CORE_ID = 'krzysztof-d.justybaselite-netezza';
const PUBLISHER = 'krzysztof-d';
const PACKAGE_PREFIX = 'justybaselite-';
const BINARY_SUFFIXES = [
  '.node', '.dll', '.so', '.dylib', '.exe', '.wasm', '.jar', '.pyd', '.a', '.lib',
];
const SCRIPT_SUFFIXES = ['.ps1', '.bat', '.cmd', '.sh', '.py'];
const TEXT_SUFFIXES = [
  '.js', '.cjs', '.mjs', '.json', '.md', '.txt', '.xml', '.html', '.css',
  '.yml', '.yaml', '.sql', '.ts', '.tsx', '.toml', '.ini', '.properties',
];
const NONESSENTIAL_FIRST_PARTY = [
  /\/(?:__tests__|tests?|fixtures|coverage)\//i,
  /\/jest(?:\.[^/]+)?\.config\.[cm]?js$/i,
  /\/tsconfig(?:\.[^/]+)?\.json$/i,
  /\.tsbuildinfo$/i,
  /\/package-lock\.json$/i,
  /\/docker-compose(?:\.[^/]+)?\.ya?ml$/i,
  /\/src\/.*\.(?:ts|tsx)$/i,
];
const NONESSENTIAL_DEPENDENCY = [
  /\.d\.(?:ts|cts|mts)$/i,
  /\/(?:__tests__|tests?|specs?)\//i,
  /\/(?:test|tests|spec)\.[cm]?js$/i,
  /\/(?:[^/]+\.)?(?:test|spec)\.[cm]?js$/i,
  /\/(?:tsconfig[^/]*\.json|\.eslintrc[^/]*|\.npmignore)$/i,
  /\/(?:readme|changelog|changes|migration_guide)[^/]*$/i,
];
const SECRET_PATTERNS = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'npm access token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readEntryText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  assert(entry, `missing ${entryName}`);
  return zip.readAsText(entry, 'utf8');
}

function isNodeModule(file) {
  return file.startsWith('extension/node_modules/');
}

function isProbablyMinified(source) {
  if (Buffer.byteLength(source) < 4096) {
    return false;
  }
  const lines = source.split(/\r?\n/).filter(line => line.trim().length > 0);
  const longestLine = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
  const averageLineLength = source.length / Math.max(lines.length, 1);
  return lines.length < 20 || averageLineLength > 300 || longestLine > 20_000;
}

function sourceMapReference(source) {
  const match = source.match(/[#@]\s*sourceMappingURL=([^\s*]+)/);
  return match?.[1];
}

function validateSourceMap(zip, files, scriptName, source) {
  const reference = sourceMapReference(source);
  const siblingMap = `${scriptName}.map`;
  const mapName = reference
    ? path.posix.normalize(path.posix.join(path.posix.dirname(scriptName), reference))
    : files.includes(siblingMap)
      ? siblingMap
      : undefined;

  if (reference) {
    assert(!reference.startsWith('data:'), `${scriptName}: inline/encoded source map is not allowed`);
    assert(mapName?.startsWith('extension/'), `${scriptName}: invalid source map path ${reference}`);
    assert(files.includes(mapName), `${scriptName}: referenced source map is missing: ${mapName}`);
  }

  // Large generated/bundled scripts must remain traceable even if they do not
  // contain an explicit sourceMappingURL comment.
  if (Buffer.byteLength(source) >= 100_000) {
    assert(mapName, `${scriptName}: large JavaScript file is missing a source map`);
  }

  if (!mapName) {
    return undefined;
  }

  const map = JSON.parse(readEntryText(zip, mapName));
  assert(Array.isArray(map.sources) && map.sources.length > 0, `${mapName}: sources are missing`);
  assert(
    Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length,
    `${mapName}: sourcesContent is incomplete`,
  );
  const missingEmbeddedSources = map.sources.filter((sourceName, index) =>
    typeof map.sourcesContent[index] !== 'string');
  assert(
    missingEmbeddedSources.every(sourceName => sourceName.replaceAll('\\', '/').includes('/node_modules/')),
    `${mapName}: first-party embedded sources are missing: ${missingEmbeddedSources.join(', ')}`,
  );
  return mapName;
}

function packageRootForNodeModule(files, file) {
  let candidate = path.posix.dirname(file);
  while (candidate.startsWith('extension/node_modules/')) {
    if (files.includes(`${candidate}/package.json`)) {
      return candidate;
    }
    candidate = path.posix.dirname(candidate);
  }
  return undefined;
}

function isDependencyPackageManifest(file) {
  if (!isNodeModule(file) || !file.endsWith('/package.json')) {
    return false;
  }
  const normalized = file.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  const relative = markerIndex >= 0
    ? normalized.slice(markerIndex + marker.length)
    : normalized.slice('extension/node_modules/'.length);
  const segments = relative.split('/');
  return segments[0].startsWith('@')
    ? segments.length === 3 && segments[2] === 'package.json'
    : segments.length === 2 && segments[1] === 'package.json';
}

function inspectVsix(filePath) {
  const zip = new AdmZip(filePath);
  const files = zip.getEntries().filter(entry => !entry.isDirectory).map(entry => entry.entryName);
  const lowerFiles = new Set(files.map(file => file.toLowerCase()));
  assert(files.includes('extension/package.json'), `${filePath}: missing extension/package.json`);

  const manifest = JSON.parse(readEntryText(zip, 'extension/package.json'));
  assert(manifest.publisher === PUBLISHER, `${filePath}: expected publisher ${PUBLISHER}, got ${manifest.publisher}`);
  assert(manifest.name?.startsWith(PACKAGE_PREFIX), `${filePath}: expected a ${PACKAGE_PREFIX} package name`);
  assert(typeof manifest.license === 'string' && manifest.license.length > 0, `${filePath}: license field is missing`);

  const hasRootLicense = files.some(file => /^extension\/licen[cs]e(?:\.[^/]+)?$/i.test(file));
  assert(hasRootLicense, `${filePath}: root license text is missing`);
  assert(
    lowerFiles.has('extension/third_party_notices.md'),
    `${filePath}: THIRD_PARTY_NOTICES.md is missing`,
  );

  if (manifest.name !== 'justybaselite-netezza') {
    assert(
      manifest.extensionDependencies?.includes(CORE_ID),
      `${filePath}: optional extension must depend on ${CORE_ID}`,
    );
  }

  const forbiddenFiles = files.filter(file => {
    if (isNodeModule(file)) {
      return false;
    }
    return NONESSENTIAL_FIRST_PARTY.some(pattern => pattern.test(`/${file}`));
  });
  assert(
    forbiddenFiles.length === 0,
    `${filePath}: non-runtime files were packaged: ${forbiddenFiles.join(', ')}`,
  );
  const forbiddenDependencyFiles = files.filter(file =>
    isNodeModule(file) && NONESSENTIAL_DEPENDENCY.some(pattern => pattern.test(`/${file}`)));
  assert(
    forbiddenDependencyFiles.length === 0,
    `${filePath}: non-runtime dependency files were packaged: ${forbiddenDependencyFiles.join(', ')}`,
  );

  const environmentFiles = files.filter(file => /(^|\/)\.env(?:\.|$)/i.test(file));
  assert(environmentFiles.length === 0, `${filePath}: environment file(s) packaged: ${environmentFiles.join(', ')}`);

  const firstPartyTextFiles = files.filter(file => {
    if (isNodeModule(file)) {
      return false;
    }
    const lower = file.toLowerCase();
    return TEXT_SUFFIXES.some(suffix => lower.endsWith(suffix));
  });
  for (const textFile of firstPartyTextFiles) {
    const textContent = readEntryText(zip, textFile);
    for (const secret of SECRET_PATTERNS) {
      assert(!secret.pattern.test(textContent), `${filePath}: ${textFile} contains a possible ${secret.name}`);
    }
  }

  const firstPartyScripts = files.filter(file => file.endsWith('.js') && !isNodeModule(file));
  assert(firstPartyScripts.length > 0, `${filePath}: no first-party JavaScript found`);
  const sourceMaps = [];

  for (const script of firstPartyScripts) {
    const source = readEntryText(zip, script);
    assert(!isProbablyMinified(source), `${filePath}: ${script} appears heavily minified`);
    assert(!/\beval\s*\(/.test(source), `${filePath}: ${script} contains eval()`);
    assert(!/\bnew\s+Function\s*\(/.test(source), `${filePath}: ${script} contains new Function()`);
    const mapName = validateSourceMap(zip, files, script, source);
    if (mapName) {
      sourceMaps.push(mapName);
    }

  }

  const sensitiveFiles = files.filter(file =>
    !isNodeModule(file) && /\.(?:pem|key|p12|pfx|jks)$/i.test(file));
  assert(sensitiveFiles.length === 0, `${filePath}: sensitive key/certificate files packaged: ${sensitiveFiles.join(', ')}`);

  const notices = readEntryText(zip, 'extension/THIRD_PARTY_NOTICES.md');
  const dependencyManifests = files.filter(isDependencyPackageManifest);
  for (const dependencyManifestName of dependencyManifests) {
    const dependencyManifest = JSON.parse(readEntryText(zip, dependencyManifestName));
    assert(
      dependencyManifest.name && dependencyManifest.version,
      `${filePath}: invalid dependency manifest ${dependencyManifestName}`,
    );
    const packageRoot = path.posix.dirname(dependencyManifestName);
    const hasPackageLicense = dependencyManifest.license || files.some(file =>
      file.startsWith(`${packageRoot}/`) && /^licen[cs]e(?:\.[^/]+)?$/i.test(path.posix.basename(file)));
    assert(hasPackageLicense, `${filePath}: ${dependencyManifest.name}@${dependencyManifest.version} has no license`);
    assert(
      notices.includes(`${dependencyManifest.name}@${dependencyManifest.version}`)
        || notices.includes(`| ${dependencyManifest.name} | ${dependencyManifest.version} |`),
      `${filePath}: missing third-party notice for ${dependencyManifest.name}@${dependencyManifest.version}`,
    );
  }

  const executableAssets = files.filter(file => {
    const lower = file.toLowerCase();
    return BINARY_SUFFIXES.some(suffix => lower.endsWith(suffix))
      || SCRIPT_SUFFIXES.some(suffix => lower.endsWith(suffix));
  });
  const executablePackages = new Set();
  for (const asset of executableAssets) {
    assert(isNodeModule(asset), `${filePath}: executable asset outside runtime dependency: ${asset}`);
    const packageRoot = packageRootForNodeModule(files, asset);
    assert(packageRoot, `${filePath}: ${asset} has no owning package directory`);
    const packageManifestName = `${packageRoot}/package.json`;
    assert(files.includes(packageManifestName), `${filePath}: ${asset} has no owning package manifest`);
    const packageManifest = JSON.parse(readEntryText(zip, packageManifestName));
    assert(packageManifest.name && packageManifest.version, `${filePath}: invalid package metadata for ${asset}`);
    assert(packageManifest.license, `${filePath}: owning package for ${asset} does not declare a license`);
    executablePackages.add(`${packageManifest.name}@${packageManifest.version}`);
  }

  return {
    file: path.basename(filePath),
    sha256: sha256(filePath),
    sizeBytes: readFileSync(filePath).length,
    identity: `${manifest.publisher}.${manifest.name}`,
    version: manifest.version,
    fileCount: files.length,
    firstPartyScripts,
    sourceMaps: [...new Set(sourceMaps)].sort(),
    executableAssets,
    executablePackages: [...executablePackages].sort(),
  };
}

const vsixFiles = readdirSync(inputDir)
  .filter(file => file.endsWith('.vsix'))
  .sort();
assert(vsixFiles.length > 0, `No VSIX files found in ${inputDir}`);

const report = {
  generatedAt: new Date().toISOString(),
  auditVersion: 2,
  artifacts: vsixFiles.map(file => inspectVsix(path.join(inputDir, file))),
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, 'marketplace-review.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  path.join(outputDir, 'SHA256SUMS'),
  report.artifacts.map(artifact => `${artifact.sha256}  ${artifact.file}`).join('\n') + '\n',
);
console.log(`Marketplace artifact audit passed for ${report.artifacts.length} VSIX file(s).`);
