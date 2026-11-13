#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { qualityStage } from './stages/quality.mjs';
import { testsStage } from './stages/tests.mjs';
import { releaseDryRunStage } from './stages/releaseDryRun.mjs';
import { prepareWorkspace } from './lib/snapshot.mjs';
import { writeSummary } from './lib/summary.mjs';

const STAGES = new Map([
    [qualityStage.id, qualityStage],
    [testsStage.id, testsStage],
    [releaseDryRunStage.id, releaseDryRunStage],
]);

const BUMP_TYPES = new Set([
    'patch',
    'minor',
    'major',
    'prepatch',
    'preminor',
    'premajor',
    'prerelease',
]);

function usage() {
    console.log(`Usage: node run.mjs <stage> [options]

Stages:
  quality           docs + quality jobs (types, lint, architecture, build)
  tests             unit/coverage, UI coverage, parser and Extension Host gates
  release-dry-run   version bump + build + VSIX package + marketplace audit
  all               run quality, tests, then release-dry-run

Options:
  --release-type <type>   patch|minor|major|prepatch|preminor|premajor|prerelease|exact
  --version <x.y.z>       explicit version, required with --release-type exact
  --base <git-ref>        enable changed high-risk coverage against a git ref
  --allow-dirty           allow release-dry-run with uncommitted changes
  --refresh-deps          force npm ci even when cached dependency hashes match
  --skip-deps             reuse installed dependencies; fail if they are missing
  --list                  list stages and exit
  --help                  show this help`);
}

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(2);
}

function parseArguments(argv) {
    if (argv.length === 0) {
        usage();
        process.exit(2);
    }

    const options = {
        releaseType: 'patch',
        version: null,
        base: null,
        allowDirty: false,
        refreshDeps: false,
        skipDeps: false,
    };

    let stage = null;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        switch (argument) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--list':
                options.list = true;
                break;
            case '--release-type':
                options.releaseType = argv[++index];
                if (!options.releaseType) fail('--release-type requires a value');
                break;
            case '--version':
                options.version = argv[++index];
                if (!options.version) fail('--version requires a value');
                break;
            case '--base':
                options.base = argv[++index];
                if (!options.base) fail('--base requires a value');
                break;
            case '--allow-dirty':
                options.allowDirty = true;
                break;
            case '--refresh-deps':
                options.refreshDeps = true;
                break;
            case '--skip-deps':
                options.skipDeps = true;
                break;
            default:
                if (argument.startsWith('-')) {
                    fail(`unknown option: ${argument}`);
                }
                if (stage) {
                    fail(`unexpected argument: ${argument}`);
                }
                stage = argument;
                break;
        }
    }

    return { stage, options };
}

function validateStage(stage, options) {
    if (options.list) return;

    if (!stage) {
        fail('a stage is required (quality, tests, release-dry-run, or all)');
    }

    if (stage !== 'all' && !STAGES.has(stage)) {
        fail(`unknown stage: ${stage}`);
    }

    if (stage === 'release-dry-run' || stage === 'all') {
        if (options.releaseType !== 'exact' && !BUMP_TYPES.has(options.releaseType)) {
            fail(`unsupported release type: ${options.releaseType}`);
        }
        if (options.releaseType === 'exact' && !options.version) {
            fail('--release-type exact requires --version <x.y.z>');
        }
    } else if (options.version || options.releaseType !== 'patch') {
        console.warn('warning: --release-type/--version are only used by release-dry-run.');
    }
}

function toolVersion(command, args) {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().split('\n')[0];
    } catch {
        return 'unavailable';
    }
}

function printPreflight(ctx) {
    console.log('=== Justybase local CI ===');
    console.log(`Requested stage: ${ctx.requestedStage}`);
    console.log(`Node: ${process.version}`);
    console.log(`npm:  ${ctx.toolVersions.npm}`);
    console.log(`git:  ${ctx.toolVersions.git}`);
    console.log(`CPUs: ${os.cpus().length}, memory: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);

    try {
        const stat = fs.statfsSync('/work');
        const freeGiB = (stat.bavail * stat.bsize) / 1024 ** 3;
        console.log(`Free disk in /work: ${freeGiB.toFixed(1)} GiB`);
        if (freeGiB < 15) {
            console.warn('warning: less than 15 GiB free; npm installs and coverage output may exhaust the volume.');
        }
    } catch {
        // statfs is optional; the first command will fail with a clearer error.
    }

    if (!fs.existsSync('/.dockerenv')) {
        console.warn('warning: this does not look like a container. Use tools/local-ci/run.sh instead.');
    }
}

async function main() {
    const { stage, options } = parseArguments(process.argv.slice(2));

    if (options.help) {
        usage();
        return;
    }

    if (options.list) {
        for (const candidate of STAGES.values()) {
            console.log(`${candidate.id}\t${candidate.description}`);
        }
        console.log('all\tRun quality, tests, then release-dry-run.');
        return;
    }

    validateStage(stage, options);

    const ctx = {
        requestedStage: stage,
        currentStage: 'setup',
        repoRoot: process.env.LOCAL_CI_REPO_ROOT || '/src',
        workDir: '/work',
        stateDir: '/ci-state',
        outDir: process.env.LOCAL_CI_OUT || '/out',
        options,
        steps: [],
        startedAt: new Date(),
        toolVersions: {
            npm: toolVersion('npm', ['--version']),
            git: toolVersion('git', ['--version']),
        },
        report: null,
    };

    printPreflight(ctx);

    if (!fs.existsSync(ctx.repoRoot)) {
        fail(`source checkout not found at ${ctx.repoRoot}`);
    }

    await prepareWorkspace(ctx).catch(error => {
        writeSummary(ctx, 'failed', { stage: 'setup', error });
        throw error;
    });

    const selected = stage === 'all'
        ? [qualityStage, testsStage, releaseDryRunStage]
        : [STAGES.get(stage)];

    let failure = null;
    for (const selectedStage of selected) {
        ctx.currentStage = selectedStage.id;
        console.log(`\n\n######## ${selectedStage.title} ########`);
        try {
            await selectedStage.run(ctx);
        } catch (error) {
            failure = { stage: selectedStage.id, error };
            break;
        }
    }

    const status = failure ? 'failed' : 'success';
    writeSummary(ctx, status, failure);

    if (failure) {
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error(`\nUnexpected local CI failure: ${error.stack ?? error}`);
    process.exitCode = 1;
});
