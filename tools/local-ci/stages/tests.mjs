import fs from 'node:fs';
import path from 'node:path';
import { captureCommand, runStep } from '../lib/exec.mjs';
import { ensureAccessReference, ensureExtensionDependencies, ensureRootDependencies } from '../lib/snapshot.mjs';

export const testsStage = {
    id: 'tests',
    title: 'Unit, coverage and regression gates',
    description: 'Coverage suites, completion parity, quick-fix regression, parser budgets, and the Extension Host result-panel gate.',

    async run(ctx) {
        await ensureRootDependencies(ctx, { force: ctx.options.refreshDeps });

        await ensureAccessReference(ctx);

        await runStep(ctx, {
            name: 'Build Access file package',
            command: 'npm',
            args: ['run', 'build:access-file'],
        });

        // Mirrors the CI unit-tests job: install the optional extension
        // dependencies that those suites load.
        for (const extension of ['clickhouse', 'duckdb', 'access']) {
            await ensureExtensionDependencies(ctx, extension, { force: ctx.options.refreshDeps });
        }

        await runStep(ctx, {
            name: 'Run complete root unit test suite with coverage',
            command: 'npm',
            args: ['run', 'test:coverage'],
        });

        await runStep(ctx, {
            name: 'Run shared UI package and VS Code webview coverage suites',
            command: 'npm',
            args: ['run', 'test:coverage:ui'],
        });

        await runStep(ctx, {
            name: 'Verify semantic token latency without coverage instrumentation',
            command: 'npm',
            args: [
                'run',
                'test:validate',
                '--',
                '--runInBand',
                '--testPathPatterns=semanticTokensProvider.test.ts',
                '--testNamePattern=tokenizes large scripts',
            ],
        });

        await runStep(ctx, {
            name: 'Run completion parity tests',
            command: 'npm',
            args: ['run', 'test:completion-parity'],
        });

        await runStep(ctx, {
            name: 'Run quick-fix regression tests',
            command: 'npm',
            args: ['run', 'test:quickfix-regression'],
        });

        await runStep(ctx, {
            name: 'Enforce parser construction budgets',
            command: 'npm',
            args: ['run', 'test:parser-perf'],
        });

        await runStep(ctx, {
            name: 'Run real VS Code result-panel scenario',
            command: 'xvfb-run',
            args: ['-a', 'npm', 'run', 'test:extension-host'],
        });

        if (ctx.options.base) {
            const base = ctx.options.base;
            const diffFile = path.join('/tmp', 'justybase-changed.diff');
            const diff = await captureCommand(ctx, {
                name: `Build changed-file diff against ${base}`,
                command: 'git',
                args: [
                    '-c', 'core.autocrlf=true',
                    '-c', 'core.fileMode=false',
                    '-C', ctx.workDir,
                    'diff',
                    '--unified=0',
                    `${base}...HEAD`,
                    '--',
                    '.',
                ],
            });
            fs.writeFileSync(diffFile, diff.stdout);

            await runStep(ctx, {
                name: 'Enforce changed high-risk coverage',
                command: 'node',
                args: [
                    'scripts/quality-gate.mjs',
                    'changed-coverage',
                    `--diff-file=${diffFile}`,
                    `--base=${base}`,
                ],
            });
        } else {
            console.log('\n==> [tests] Changed high-risk coverage skipped (pass --base <git-ref> to enable)');
        }
    },
};
