import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureCommand, runStep } from '../lib/exec.mjs';
import { ensureRootDependencies } from '../lib/snapshot.mjs';

const BUMP_TYPES = new Set([
    'patch',
    'minor',
    'major',
    'prepatch',
    'preminor',
    'premajor',
    'prerelease',
]);

function readVersion(workDirectory) {
    return JSON.parse(fs.readFileSync(path.join(workDirectory, 'package.json'), 'utf8')).version;
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function verifySourceCheckout(ctx) {
    const status = await captureCommand(ctx, {
        name: 'Verify the source checkout is clean',
        command: 'git',
        args: [
            '-c', 'core.autocrlf=true',
            '-c', 'core.fileMode=false',
            '-C', ctx.repoRoot,
            'status',
            '--porcelain',
            '--untracked-files=normal',
        ],
        allowFailure: true,
    });

    if (status.exitCode !== 0) {
        throw new Error(`Could not read the source checkout status: ${status.stderr.trim()}`);
    }

    const dirty = status.stdout.trim();
    ctx.sourceDirty = dirty.length > 0;

    if (dirty && !ctx.options.allowDirty) {
        const preview = dirty.split('\n').slice(0, 20).join('\n');
        throw new Error(
            'The source checkout has uncommitted changes, so a release cannot be reproduced faithfully.\n'
            + `${preview}\n`
            + 'Commit or stash the changes first, or pass --allow-dirty for a packaging smoke test.',
        );
    }

    if (dirty) {
        console.warn('\nwarning: continuing with a dirty source checkout because --allow-dirty was passed.');
    }

    const head = await captureCommand(ctx, {
        name: 'Record source Git HEAD',
        command: 'git',
        args: [
            '-c', 'core.fileMode=false',
            '-C', ctx.repoRoot,
            'rev-parse',
            'HEAD',
        ],
        allowFailure: true,
    });
    ctx.sourceHead = head.exitCode === 0 ? head.stdout.trim() : null;
}

async function bumpVersions(ctx) {
    const releaseType = ctx.options.releaseType;

    if (releaseType === 'exact') {
        if (!ctx.options.version) {
            throw new Error('--release-type exact requires --version <x.y.z>.');
        }
        await runStep(ctx, {
            name: `Set synchronized version ${ctx.options.version}`,
            command: 'node',
            args: [
                'scripts/version-sync.js',
                'set',
                ctx.options.version,
                '--include-optionals',
            ],
        });
        return;
    }

    if (!BUMP_TYPES.has(releaseType)) {
        throw new Error(
            `Unsupported release type "${releaseType}". Use ${[...BUMP_TYPES, 'exact'].join(', ')}.`,
        );
    }

    await runStep(ctx, {
        name: `Bump synchronized version (${releaseType})`,
        command: 'node',
        args: [
            'scripts/version-sync.js',
            'bump',
            releaseType,
            '--include-optionals',
        ],
    });
}

async function verifyRemoteTagIsFree(ctx, tag) {
    const result = await captureCommand(ctx, {
        name: `Ensure ${tag} does not exist on origin`,
        command: 'git',
        args: [
            '-C', ctx.workDir,
            'ls-remote',
            '--exit-code',
            '--tags',
            'origin',
            `refs/tags/${tag}`,
        ],
        allowFailure: true,
        allowedExitCodes: [2],
    });

    if (result.exitCode === 0) {
        throw new Error(
            `Remote tag ${tag} already exists. A real release would fail; choose another release type or version.`,
        );
    }

    if (result.exitCode !== 0 && result.exitCode !== 2) {
        console.warn(
            '\nwarning: could not verify remote tags (network or authentication). '
            + 'The real release workflow will still refuse an existing tag.',
        );
    }
}

async function packageVsix(ctx, version) {
    const workDirectory = ctx.workDir;
    const vsixName = `justybaselite-netezza-${version}.vsix`;
    const rootVsix = path.join(workDirectory, vsixName);
    const artifactsDirectory = path.join(workDirectory, 'artifacts');
    const reviewDirectory = path.join(workDirectory, 'marketplace-review');

    fs.rmSync(rootVsix, { force: true });
    fs.rmSync(artifactsDirectory, { recursive: true, force: true });
    fs.rmSync(reviewDirectory, { recursive: true, force: true });
    // `all` reuses one snapshot, so a docs build from the quality stage can
    // still be present here. A clean CI checkout never contains it.
    fs.rmSync(path.join(workDirectory, '_site'), { recursive: true, force: true });

    await runStep(ctx, {
        name: 'Build release bundles',
        command: 'npm',
        args: ['run', 'build'],
    });

    await runStep(ctx, {
        name: `Package main VSIX ${version}`,
        command: 'npm',
        args: ['run', 'package', '--', '--out', vsixName],
    });

    if (!fs.existsSync(rootVsix)) {
        throw new Error(`Packaging did not produce ${vsixName}.`);
    }

    const sizeBytes = fs.statSync(rootVsix).size;
    if (sizeBytes < 1024) {
        throw new Error(`Packaged VSIX is unexpectedly small (${sizeBytes} bytes).`);
    }

    fs.mkdirSync(artifactsDirectory, { recursive: true });
    fs.renameSync(rootVsix, path.join(artifactsDirectory, vsixName));

    await runStep(ctx, {
        name: 'Audit VSIX reviewability and identities',
        command: 'node',
        args: [
            'scripts/audit-marketplace-vsix.js',
            'artifacts',
            'marketplace-review',
        ],
    });

    const checksumFile = path.join(reviewDirectory, 'SHA256SUMS');
    if (!fs.existsSync(checksumFile)) {
        throw new Error('Marketplace audit did not produce marketplace-review/SHA256SUMS.');
    }

    return {
        vsixPath: path.join(artifactsDirectory, vsixName),
        vsixName,
        sizeBytes,
        reviewDirectory,
        reviewChecksumFile: checksumFile,
    };
}

function exportOutputs(ctx, version, result) {
    const outputDirectory = path.join(ctx.outDir, 'release-dry-run', version);
    fs.mkdirSync(outputDirectory, { recursive: true });

    const outputVsix = path.join(outputDirectory, result.vsixName);
    fs.copyFileSync(result.vsixPath, outputVsix);
    fs.cpSync(result.reviewDirectory, path.join(outputDirectory, 'marketplace-review'), {
        recursive: true,
    });

    return outputDirectory;
}

export const releaseDryRunStage = {
    id: 'release-dry-run',
    title: 'Release dry run (no publish, tag, or push)',
    description: 'Bumps versions in the disposable snapshot, builds and packages the VSIX, and runs the marketplace audit.',

    async run(ctx) {
        await verifySourceCheckout(ctx);

        const previousVersion = readVersion(ctx.workDir);
        console.log(`\n==> [release-dry-run] Previous version: ${previousVersion}`);

        await bumpVersions(ctx);

        const version = readVersion(ctx.workDir);
        const tag = `v${version}`;
        console.log(`==> [release-dry-run] Next version: ${version} (${tag})`);

        await runStep(ctx, {
            name: `Validate synchronized release metadata for ${tag}`,
            command: 'node',
            args: [
                'scripts/version-sync.js',
                'check',
                '--release-tag',
                tag,
                '--include-optionals',
            ],
        });

        await verifyRemoteTagIsFree(ctx, tag);

        const changedFiles = await captureCommand(ctx, {
            name: 'Record version files changed in the snapshot',
            command: 'git',
            args: [
                '-c', 'core.autocrlf=true',
                '-c', 'core.fileMode=false',
                '-C', ctx.workDir,
                'status',
                '--porcelain',
                '--untracked-files=normal',
            ],
        });

        const changedFileList = changedFiles.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        if (changedFileList.length === 0) {
            throw new Error('The version bump produced no changes; the release workflow would fail.');
        }

        await ensureRootDependencies(ctx, { force: ctx.options.refreshDeps });

        const packageResult = await packageVsix(ctx, version);
        const sha256 = sha256File(packageResult.vsixPath);
        const outputDirectory = exportOutputs(ctx, version, packageResult);

        const report = {
            previousVersion,
            version,
            tag,
            vsix: {
                name: packageResult.vsixName,
                sizeBytes: packageResult.sizeBytes,
                sha256,
            },
            changedFiles: changedFileList,
            outputDirectory,
            published: false,
            pushed: false,
            tagged: false,
            sourceCheckoutModified: false,
            note: 'Version bump, build, and packaging ran only in the disposable /work snapshot.',
            generatedAt: new Date().toISOString(),
        };

        fs.writeFileSync(
            path.join(outputDirectory, 'release-dry-run.json'),
            `${JSON.stringify(report, null, 2)}\n`,
        );

        ctx.report = { release: report };

        console.log('\n=== Release dry run completed ===');
        console.log(`Version: ${previousVersion} -> ${version}`);
        console.log(`Tag (not created): ${tag}`);
        console.log(`VSIX: ${path.join(outputDirectory, packageResult.vsixName)}`);
        console.log(`SHA256: ${sha256}`);
        console.log('The source checkout was not modified.');
        console.log('Nothing was committed, tagged, pushed, attached to a release, or published.');
    },
};
