import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatDuration } from './exec.mjs';

function timestamp(date) {
    return date.toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

function stepStatusLabel(status) {
    switch (status) {
        case 'success':
            return 'ok';
        case 'allowed-failure':
            return 'warning';
        default:
            return 'FAILED';
    }
}

function buildMarkdown(payload) {
    const lines = [
        `# Local CI: ${payload.requestedStage}`,
        '',
        `- Status: **${payload.status}**`,
        `- Started: ${payload.startedAt}`,
        `- Finished: ${payload.finishedAt}`,
        `- Duration: ${formatDuration(payload.durationMs)}`,
        `- Source: \`${payload.source.repoRoot}\``,
        `- Git HEAD: \`${payload.source.gitHead ?? 'unknown'}\``,
        `- Node: ${payload.environment.node}`,
        `- npm: ${payload.environment.npm}`,
        '',
    ];

    if (payload.failure) {
        lines.push('## Failure', '', `- Stage: \`${payload.failure.stage}\``, `- Error: ${payload.failure.message}`, '');
    }

    if (payload.release) {
        lines.push(
            '## Release dry run',
            '',
            `- Version: \`${payload.release.version}\` (from \`${payload.release.previousVersion}\`)`,
            `- Tag: \`${payload.release.tag}\``,
            `- VSIX: \`${payload.release.vsix.name}\` (${payload.release.vsix.sizeBytes} bytes)`,
            `- SHA256: \`${payload.release.vsix.sha256}\``,
            '- Published: no',
            '- Pushed: no',
            '- Tagged: no',
            '',
        );
    }

    lines.push('## Steps', '', '| # | Stage | Step | Status | Duration |', '|---|-------|------|--------|----------|');
    payload.steps.forEach((step, index) => {
        lines.push(`| ${index + 1} | ${step.stage} | ${step.name.replaceAll('|', '\\|')} | ${stepStatusLabel(step.status)} | ${formatDuration(step.durationMs)} |`);
    });
    lines.push('');

    return lines.join('\n');
}

export function writeSummary(ctx, status, failure) {
    const finishedAt = new Date();
    const payload = {
        schemaVersion: 1,
        tool: 'justybase-local-ci',
        requestedStage: ctx.requestedStage,
        lastStage: ctx.currentStage,
        status,
        startedAt: ctx.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - ctx.startedAt.getTime(),
        source: {
            repoRoot: ctx.repoRoot,
            gitHead: ctx.sourceHead ?? null,
            dirty: ctx.sourceDirty ?? null,
        },
        environment: {
            node: process.version,
            npm: ctx.toolVersions?.npm ?? null,
            git: ctx.toolVersions?.git ?? null,
            platform: `${process.platform}-${process.arch}`,
            cpus: os.cpus().length,
            memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        },
        options: ctx.options,
        steps: ctx.steps.map(({ stdout: _stdout, stderr: _stderr, ...rest }) => rest),
        ...(failure ? {
            failure: {
                stage: failure.stage,
                message: failure.error?.message ?? String(failure.error),
            },
        } : {}),
        ...(ctx.report ?? {}),
    };

    const stamp = timestamp(finishedAt);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const markdown = buildMarkdown(payload);

    try {
        fs.mkdirSync(ctx.outDir, { recursive: true });
        const baseName = `summary-${ctx.requestedStage}-${stamp}`;
        fs.writeFileSync(path.join(ctx.outDir, `${baseName}.json`), json);
        fs.writeFileSync(path.join(ctx.outDir, `${baseName}.md`), markdown);
        fs.writeFileSync(path.join(ctx.outDir, `latest-${ctx.requestedStage}.json`), json);
        fs.writeFileSync(path.join(ctx.outDir, `latest-${ctx.requestedStage}.md`), markdown);
    } catch (error) {
        console.warn(`\nwarning: could not write the summary to ${ctx.outDir}: ${error.message}`);
    }

    console.log(`\n=== Local CI summary: ${status.toUpperCase()} ===`);
    for (const step of ctx.steps) {
        const icon = step.status === 'success' ? 'ok  ' : (step.status === 'allowed-failure' ? 'warn' : 'FAIL');
        console.log(`  ${icon} ${step.stage.padEnd(16)} ${step.name} (${formatDuration(step.durationMs)})`);
    }
    console.log(`Total: ${formatDuration(payload.durationMs)}`);

    if (failure) {
        console.error(`\nStage "${failure.stage}" failed: ${failure.error?.message ?? failure.error}`);
    }
}
