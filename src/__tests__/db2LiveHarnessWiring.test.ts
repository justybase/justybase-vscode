import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

interface HarnessOptions {
    image: string;
    database: string;
    user: string;
    password: string;
    fixtureSchema: string;
    containerName: string;
    explainDdlPath: string;
}

interface HarnessConfigModule {
    buildFixtureSql(schema?: string): string;
    buildJestEnv(options: HarnessOptions, hostPort: number): Record<string, string>;
    readHarnessOptions(env: NodeJS.ProcessEnv): HarnessOptions;
}

const harness: HarnessConfigModule = require('../../scripts/db2-live-harness-config.cjs');

function readJson(relativePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('Db2 ephemeral harness wiring', () => {
    const scripts = readJson('package.json').scripts as Record<string, string>;
    const harnessSource = fs.readFileSync(
        path.join(repoRoot, 'scripts/db2-live-harness.mjs'),
        'utf8',
    );

    it('exposes the ephemeral harness and verify:db2:live scripts', () => {
        expect(scripts['test:db2:live:ephemeral']).toBe('node scripts/db2-live-harness.mjs');
        expect(scripts['verify:db2:live']).toContain('npm run test:db2:live:ephemeral');
        expect(scripts['test:db2:integration:all']).toContain('db2Runstats.live.integration.test.ts');
    });

    it('never pulls an image unless the caller opts in', () => {
        expect(harnessSource).toContain('DB2_HARNESS_ALLOW_PULL');
        expect(harnessSource).toContain('pulling is disabled');
    });

    it('removes the disposable container in a finally block', () => {
        expect(harnessSource).toMatch(/finally\s*\{\s*teardown\(\);/);
        expect(harnessSource).toContain('rm');
        expect(harnessSource).toContain('--force');
        expect(harnessSource).toContain('containerStarted');
    });

    it('passes the fixture SQL through stdin without shell interpolation', () => {
        expect(harnessSource).toContain('base64 -d');
        expect(harnessSource).toContain("execScript(");
        expect(harnessSource).not.toMatch(/db2 -tvf \$\{fixtureSql\}/);
    });

    it('marks the run as strict and provisions EXPLAIN tables before Jest', () => {
        const env = harness.buildJestEnv(
            {
                ...harness.readHarnessOptions({}),
                password: 'Secret9!',
            },
            32768,
        );

        expect(env.JUSTYBASE_DB2_EPHEMERAL).toBe('1');
        expect(env.DB2_LIVE_TEST_REQUIRED).toBe('true');
        expect(harnessSource.indexOf('provisionExplainTables()')).toBeGreaterThan(0);
        expect(harnessSource.indexOf('provisionExplainTables()')).toBeLessThan(
            harnessSource.indexOf('runJest(hostPort)'),
        );
        expect(harness.buildFixtureSql('JBL_LIVE')).toContain('JBL_ALIAS_CUSTOMERS');
    });
});
