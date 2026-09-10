#!/usr/bin/env node

/**
 * Generates JetIndexCodesData.ts from the pinned Jackcess index-code resource
 * tables mirrored by JustyBase.UCanAccessCs.
 *
 * The generator is deliberately fail-closed: it verifies the exact upstream
 * checkout and every source checksum before it reads or writes generated data.
 * Run without arguments to verify the checked-in output; use --write only when
 * intentionally regenerating it after reviewing the manifest.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLONE_ROOT = path.join(REPO_ROOT, 'tools', 'access-ddl-compare', '.clone');
const MANIFEST_PATH = path.join(REPO_ROOT, 'tools', 'access-ddl-compare', 'access-index-codes.manifest.json');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function canonicalizeResource(text) {
    return text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}

function sha256Text(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fail(message) {
    throw new Error(`[access-index-codes] ${message}`);
}

function getManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        fail(`manifest is missing: ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
    }

    const manifest = readJson(MANIFEST_PATH);
    if (manifest.schemaVersion !== 1) {
        fail('manifest schemaVersion must be 1.');
    }
    if (!manifest.upstream?.ref || !manifest.upstream?.repository) {
        fail('manifest must pin upstream.repository and upstream.ref.');
    }
    if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
        fail('manifest must list at least one source resource.');
    }
    if (!manifest.generated?.file || !manifest.generated?.sha256 || !Number.isInteger(manifest.generated.bytes)) {
        fail('manifest must pin generated.file, generated.sha256, and generated.bytes.');
    }
    return manifest;
}

function getPinnedCheckoutHead() {
    if (!fs.existsSync(path.join(CLONE_ROOT, '.git'))) {
        fail(`pinned checkout is missing at ${path.relative(REPO_ROOT, CLONE_ROOT)}; run tools/access-ddl-compare/bootstrap.sh.`);
    }

    const result = spawnSync('git', ['-C', CLONE_ROOT, 'rev-parse', 'HEAD'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    if (result.status !== 0) {
        fail(`cannot read checkout HEAD: ${(result.stderr || '').trim() || 'git rev-parse failed'}`);
    }

    return result.stdout.trim();
}

function verifySources(manifest) {
    const actualHead = getPinnedCheckoutHead();
    if (actualHead !== manifest.upstream.ref) {
        fail(`checkout HEAD ${actualHead} does not match pinned ref ${manifest.upstream.ref}; do not regenerate from an unreviewed revision.`);
    }

    const sourceLines = [];
    for (const source of manifest.sources) {
        if (!source.name || !source.file || !/^[a-f0-9]{64}$/u.test(source.sha256)) {
            fail('each source must define name, file, and a lowercase SHA-256 checksum.');
        }

        const filePath = path.join(CLONE_ROOT, manifest.resourceRoot, source.file);
        if (!fs.existsSync(filePath)) {
            fail(`source resource is missing: ${path.relative(REPO_ROOT, filePath)}`);
        }

        const canonical = canonicalizeResource(fs.readFileSync(filePath, 'utf8'));
        const actualHash = sha256Text(canonical);
        if (actualHash !== source.sha256) {
            fail(`${source.file} checksum mismatch: expected ${source.sha256}, got ${actualHash}.`);
        }

        sourceLines.push({ name: source.name, lines: canonical.length > 0 ? canonical.split('\n') : [] });
    }

    return sourceLines;
}

function emitStringArray(name, lines) {
    const escaped = lines.map(line => JSON.stringify(line));
    return `export const ${name}: readonly string[] = [\n    ${escaped.join(',\n    ')},\n];\n`;
}

function renderGeneratedFile(sourceLines) {
    let output = `/* istanbul ignore file */
/**
 * @generated
 * GENERATED FILE — do not edit by hand.
 *
 * Index code tables ported from the Jackcess project (Apache-2.0):
 * https://github.com/spannm/jackcess (Resources/index_codes_*.txt),
 * mirrored through JustyBase.UCanAccessCs.
 *
 * Regenerate with: node scripts/generate-index-codes.cjs --write
 */

`;

    for (const source of sourceLines) {
        output += emitStringArray(source.name, source.lines);
    }

    return output;
}

function verifyGeneratedOutput(manifest, output) {
    const outputPath = path.join(REPO_ROOT, manifest.generated.file);
    if (!fs.existsSync(outputPath)) {
        fail(`generated output is missing: ${manifest.generated.file}`);
    }

    const actualBytes = Buffer.byteLength(output);
    const actualHash = sha256Text(output);
    if (actualBytes !== manifest.generated.bytes || actualHash !== manifest.generated.sha256) {
        fail(
            `generated output checksum mismatch for ${manifest.generated.file}: `
            + `expected ${manifest.generated.sha256} (${manifest.generated.bytes} bytes), `
            + `got ${actualHash} (${actualBytes} bytes); run --write only after reviewing source changes.`,
        );
    }

    const checkedInHash = sha256File(outputPath);
    if (checkedInHash !== actualHash) {
        fail(`checked-in output differs from deterministic rendering: ${manifest.generated.file}`);
    }
}

function main(argv = process.argv.slice(2)) {
    const mode = argv.length === 0 || argv.includes('--check') ? 'check' : argv.includes('--write') ? 'write' : undefined;
    if (!mode || argv.some(arg => !['--check', '--write'].includes(arg))) {
        fail('usage: node scripts/generate-index-codes.cjs [--check|--write]');
    }

    const manifest = getManifest();
    const sourceLines = verifySources(manifest);
    const output = renderGeneratedFile(sourceLines);
    const outputPath = path.join(REPO_ROOT, manifest.generated.file);

    if (mode === 'write') {
        fs.writeFileSync(outputPath, output, 'utf8');
        console.log(`Wrote ${manifest.generated.file} (${sha256Text(output)}, ${Buffer.byteLength(output)} bytes).`);
        console.log('Update the generated.sha256/generated.bytes fields in the manifest, then run the generator without arguments.');
        return;
    }

    verifyGeneratedOutput(manifest, output);
    console.log(`Access index-code data is reproducible (${manifest.upstream.ref}, ${manifest.sources.length} resources).`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    canonicalizeResource,
    renderGeneratedFile,
    sha256Text,
};
