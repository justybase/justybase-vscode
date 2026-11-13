import { runStep } from '../lib/exec.mjs';
import { ensureAccessReference, ensureExtensionDependencies, ensureRootDependencies } from '../lib/snapshot.mjs';

export const integrationStage = {
    id: 'integration',
    title: 'Local runtime integration (Core release gate)',
    description: 'DuckDB and File SQL integration suites that a Core release runs in the integration gate.',

    async run(ctx) {
        await ensureRootDependencies(ctx, { force: ctx.options.refreshDeps });

        // A Core release still runs the integration gate. The shared Access
        // file reader is a File SQL dependency, so the pinned reference and
        // the package build stay; the Access companion extension is a separate
        // publish target and is intentionally not installed here.
        await ensureAccessReference(ctx);

        await runStep(ctx, {
            name: 'Build Access file package',
            command: 'npm',
            args: ['run', 'build:access-file'],
        });

        await ensureExtensionDependencies(ctx, 'duckdb', { force: ctx.options.refreshDeps });

        await runStep(ctx, {
            name: 'Run DuckDB integration tests',
            command: 'npm',
            args: ['run', 'test:duckdb:integration'],
        });

        await runStep(ctx, {
            name: 'Run File SQL integration tests',
            command: 'npm',
            args: ['run', 'test:file:integration'],
        });
    },
};
