#!/usr/bin/env node

/**
 * Builds the UCanAccess bridge fat-jar and copies it into resources/ so it is
 * bundled into the extension VSIX.
 *
 * Requires a JDK (11+) and Maven on PATH:
 *
 *   npm run build:access-jar
 *
 * Output: extensions/access/resources/access-bridge.jar
 */

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const bridgeDir = path.join(extensionRoot, 'java-bridge');
const pomPath = path.join(bridgeDir, 'pom.xml');
const builtJar = path.join(bridgeDir, 'target', 'access-bridge.jar');
const resourcesDir = path.join(extensionRoot, 'resources');
const destination = path.join(resourcesDir, 'access-bridge.jar');
const checksumDestination = `${destination}.sha256`;
const sbomDestination = path.join(resourcesDir, 'access-bridge.sbom.json');
const lockManifestPath = path.join(bridgeDir, 'dependency-lock.json');
const useShell = process.platform === 'win32';

function fail(message) {
    console.error(`[access-bridge] ${message}`);
    process.exit(1);
}

function checkTool(command, hint, options = {}) {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore', ...options });
    if (result.error) {
        fail(`'${command}' is not available. ${hint}`);
    }
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyLocalArtifacts(lockManifest) {
    const localRepository = process.env.MAVEN_REPO_LOCAL || path.join(require('node:os').homedir(), '.m2', 'repository');
    for (const artifact of [...(lockManifest.dependencies || []), ...(lockManifest.plugins || [])]) {
        const [groupId, artifactId] = artifact.name.split(':');
        const artifactPath = path.join(
            localRepository,
            ...groupId.split('.'),
            artifactId,
            artifact.version,
            `${artifactId}-${artifact.version}.jar`,
        );
        if (!fs.existsSync(artifactPath)) {
            fail(`Pinned Maven artifact is missing from the local repository: ${artifact.name}:${artifact.version}`);
        }
        const actual = sha256(artifactPath);
        if (actual !== artifact.sha256) {
            fail(`Pinned Maven artifact checksum mismatch for ${artifact.name}:${artifact.version}`);
        }
    }
}

function writeSbom(lockManifest) {
    const components = [
        {
            type: 'library',
            group: 'io.justybase',
            name: 'ucanaccess-bridge',
            version: '1.0.0',
            licenses: [{ license: { id: 'Apache-2.0' } }],
        },
        ...(lockManifest.dependencies || []).map(dependency => ({
            type: 'library',
            group: dependency.name.split(':')[0],
            name: dependency.name.split(':')[1],
            version: dependency.version,
            hashes: [{ alg: 'SHA-256', content: dependency.sha256 }],
            licenses: [{ license: { id: dependency.license } }],
            externalReferences: dependency.repository
                ? [{ type: 'vcs', url: dependency.repository }]
                : undefined,
        })),
    ];
    fs.writeFileSync(sbomDestination, `${JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000001',
        version: 1,
        metadata: {
            component: { type: 'application', name: 'justybaselite-access-bridge', version: '1.0.0' },
        },
        components,
    }, null, 2)}\n`, 'utf8');
}

const lockManifest = readJson(lockManifestPath);

checkTool('java', 'A Java 11+ runtime (JRE or JDK) is required to build the Access bridge.');
const mvnCommand = process.platform === 'win32'
    ? path.join(bridgeDir, 'mvnw.cmd')
    : path.join(bridgeDir, 'mvnw');
checkTool(mvnCommand, 'Maven Wrapper is required to build the Access bridge.', { cwd: bridgeDir, shell: useShell });

const build = spawnSync(mvnCommand, ['-f', pomPath, 'clean', 'package', '--batch-mode'], {
    cwd: bridgeDir,
    stdio: 'inherit',
    shell: useShell,
});

if (build.status !== 0) {
    fail(`Maven build failed with status ${build.status ?? 'unknown'}.`);
}

if (!fs.existsSync(builtJar)) {
    fail(`Expected build output '${path.relative(extensionRoot, builtJar)}' was not produced.`);
}

verifyLocalArtifacts(lockManifest);

fs.mkdirSync(resourcesDir, { recursive: true });
const temporaryDestination = `${destination}.tmp`;
fs.copyFileSync(builtJar, temporaryDestination);
const digest = sha256(temporaryDestination);
fs.renameSync(temporaryDestination, destination);
fs.writeFileSync(checksumDestination, `${digest}  access-bridge.jar\n`, 'utf8');
writeSbom(lockManifest);

const sizeMb = (fs.statSync(destination).size / (1024 * 1024)).toFixed(1);
console.log(`[access-bridge] Copied ${sizeMb} MB bridge jar to resources/access-bridge.jar (${digest})`);
