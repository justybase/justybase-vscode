import fs from 'node:fs';
import path from 'node:path';
import { runStep } from '../lib/exec.mjs';
import { ensureAccessReference, ensureExtensionDependencies, ensureRootDependencies } from '../lib/snapshot.mjs';

// Mirrors the conditional type-check steps in .github/workflows/ci.yml.
const EXTENSION_TYPECHECKS = [
    ['db2', 'DB2'],
    ['duckdb', 'DuckDB'],
    ['oracle', 'Oracle'],
    ['postgresql', 'PostgreSQL'],
    ['vertica', 'Vertica'],
    ['mssql', 'MS SQL'],
    ['mysql', 'MySQL'],
    ['clickhouse', 'ClickHouse'],
    ['snowflake', 'Snowflake'],
];

export const qualityStage = {
    id: 'quality',
    title: 'Quality Checks',
    description: 'Documentation, type checks, architecture boundaries, lint, quality tooling, and the desktop build.',

    async run(ctx) {
        await ensureRootDependencies(ctx, { force: ctx.options.refreshDeps });

        // The separate CI "docs" job is folded into this stage because it uses
        // the same dependency installation.
        await runStep(ctx, {
            name: 'Build and check documentation (docs job)',
            command: 'npm',
            args: ['run', 'docs:check'],
        });

        await ensureAccessReference(ctx);

        await runStep(ctx, {
            name: 'Verify Access generated index-code data',
            command: 'npm',
            args: ['run', 'check:access-index-codes'],
        });

        await ensureExtensionDependencies(ctx, 'clickhouse', { force: ctx.options.refreshDeps });

        await runStep(ctx, {
            name: 'Audit production dependencies',
            command: 'npm',
            args: ['audit', '--omit=dev', '--audit-level=high'],
        });

        await runStep(ctx, {
            name: 'Validate synchronized versions',
            command: 'npm',
            args: ['run', 'version:check'],
        });

        await runStep(ctx, {
            name: 'Type check core',
            command: 'npm',
            args: ['run', 'check-types'],
        });

        await runStep(ctx, {
            name: 'Check shared package boundaries',
            command: 'npm',
            args: ['run', 'check:architecture'],
        });

        await runStep(ctx, {
            name: 'Type check shared packages',
            command: 'npm',
            args: ['run', 'check-types:shared'],
        });

        for (const [id, label] of EXTENSION_TYPECHECKS) {
            const lockFile = path.join(ctx.workDir, 'extensions', id, 'package-lock.json');
            if (!fs.existsSync(lockFile)) {
                console.log(`\n==> [quality] Type check ${label} extension skipped (no package-lock.json)`);
                continue;
            }
            await runStep(ctx, {
                name: `Type check ${label} extension`,
                command: 'npm',
                args: ['run', `check-types:${id}`],
            });
        }

        await runStep(ctx, {
            name: 'Lint',
            command: 'npm',
            args: ['run', 'lint'],
        });

        await runStep(ctx, {
            name: 'Lint extended workspaces (ratchet)',
            command: 'npm',
            args: ['run', 'lint:extended:check'],
        });

        await runStep(ctx, {
            name: 'Test quality tooling',
            command: 'npm',
            args: ['run', 'test:quality-tools'],
        });

        await runStep(ctx, {
            name: 'Build desktop bundle',
            command: 'npm',
            args: ['run', 'build'],
        });
    },
};
