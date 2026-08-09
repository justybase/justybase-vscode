#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'extensions/access/package.json',
  'extensions/access/package-lock.json',
  'extensions/access/resources/access-bridge.jar',
  'extensions/access/resources/access-bridge.jar.sha256',
  'extensions/access/resources/access-bridge.sbom.json',
  'extensions/access/THIRD_PARTY_NOTICES.md',
  'extensions/access/java-bridge/pom.xml',
  'extensions/access/java-bridge/dependency-lock.json',
  'scripts/package-optional-vsix.js',
  'scripts/audit-marketplace-vsix.js',
  '.github/workflows/publish-marketplace.yml',
];

const missing = requiredFiles.filter(relative => !fs.existsSync(path.join(root, relative)));
if (missing.length > 0) {
  console.error(`Access release snapshot is incomplete:\n${missing.map(file => `- ${file}`).join('\n')}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/access/java-bridge/dependency-lock.json'), 'utf8'));
if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0) {
  throw new Error('Access Java dependency lock has no dependencies.');
}
for (const dependency of manifest.dependencies) {
  if (typeof dependency.name !== 'string' || typeof dependency.version !== 'string'
    || !/^[0-9a-f]{64}$/i.test(dependency.sha256 || '')) {
    throw new Error(`Invalid checksum entry in Access Java dependency lock: ${JSON.stringify(dependency)}`);
  }
}

const sbom = JSON.parse(fs.readFileSync(path.join(root, 'extensions/access/resources/access-bridge.sbom.json'), 'utf8'));
if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0) {
  throw new Error('Access bridge SBOM is missing or malformed.');
}
const jarPath = path.join(root, 'extensions/access/resources/access-bridge.jar');
const checksumPath = `${jarPath}.sha256`;
const expectedHash = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
const actualHash = createHash('sha256').update(fs.readFileSync(jarPath)).digest('hex');
if (!/^[0-9a-f]{64}$/.test(expectedHash || '') || expectedHash !== actualHash) {
  throw new Error(`Access bridge JAR checksum mismatch: expected ${expectedHash || '<missing>'}, got ${actualHash}`);
}
if (!fs.readFileSync(path.join(root, 'extensions/access/THIRD_PARTY_NOTICES.md'), 'utf8').includes('net.sf.ucanaccess')) {
  throw new Error('Access third-party notices do not mention UCanAccess.');
}

console.log(`Access release snapshot parity passed (${requiredFiles.length} required files).`);
