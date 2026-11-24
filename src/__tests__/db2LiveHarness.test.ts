import { describe, expect, it } from '@jest/globals';

interface HarnessOptions {
    image: string;
    imageCandidates: readonly string[];
    database: string;
    user: string;
    password: string;
    fixtureSchema: string;
    containerPrefix: string;
    containerName: string;
    readyTimeoutMs: number;
    pollIntervalMs: number;
    keepContainer: boolean;
    wslDistro: string;
    explainDdlPath: string;
}

interface HarnessConfigModule {
    DEFAULT_FIXTURE_SCHEMA: string;
    DEFAULT_IMAGE: string;
    DEFAULT_IMAGE_CANDIDATES: readonly string[];
    DEFAULT_READY_TIMEOUT_MS: number;
    buildContainerName(prefix: string, token?: string): string;
    buildDockerRunArgs(options: HarnessOptions): string[];
    buildFixtureSql(schema?: string): string;
    buildJestArgs(): string[];
    buildJestEnv(options: HarnessOptions, hostPort: number): Record<string, string>;
    generatePassword(): string;
    isStrictEphemeral(env?: NodeJS.ProcessEnv): boolean;
    parseHostPort(output: string): number | undefined;
    readHarnessOptions(env: NodeJS.ProcessEnv): HarnessOptions;
    redactSecret(text: string, secret: string): string;
}

const harness: HarnessConfigModule = require('../../scripts/db2-live-harness-config.cjs');

function options(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
    return {
        ...harness.readHarnessOptions({}),
        ...overrides,
    };
}

describe('Db2 ephemeral live harness config', () => {
    it('defaults to the cached community image and a validated fixture schema', () => {
        const parsed = harness.readHarnessOptions({});

        expect(parsed.image).toBe(harness.DEFAULT_IMAGE);
        expect(harness.DEFAULT_IMAGE_CANDIDATES).toContain('ibmcom/db2:11.5.8.0');
        expect(parsed.database).toBe('JBLTEST');
        expect(parsed.user).toBe('db2inst1');
        expect(parsed.fixtureSchema).toBe(harness.DEFAULT_FIXTURE_SCHEMA);
        expect(parsed.containerName).toMatch(/^jb-db2-live-[a-z0-9]+$/);
        expect(parsed.readyTimeoutMs).toBe(harness.DEFAULT_READY_TIMEOUT_MS);
        expect(parsed.keepContainer).toBe(false);
    });

    it('honours env overrides and normalises Db2 identifiers', () => {
        const parsed = harness.readHarnessOptions({
            DB2_HARNESS_IMAGE: 'ibmcom/db2:11.5.8.0',
            DB2_HARNESS_DATABASE: 'jbltest2',
            DB2_HARNESS_USER: 'customuser',
            DB2_LIVE_FIXTURE_SCHEMA: 'jbl_live_test',
            DB2_HARNESS_CONTAINER_TOKEN: 'token123',
            DB2_HARNESS_READY_TIMEOUT_MS: '12345',
            DB2_HARNESS_POLL_INTERVAL_MS: '250',
            DB2_HARNESS_KEEP: '1',
        });

        expect(parsed.image).toBe('ibmcom/db2:11.5.8.0');
        expect(parsed.imageCandidates).toEqual(['ibmcom/db2:11.5.8.0']);
        expect(parsed.database).toBe('JBLTEST2');
        expect(parsed.user).toBe('customuser');
        expect(parsed.fixtureSchema).toBe('JBL_LIVE_TEST');
        expect(parsed.containerName).toBe('jb-db2-live-token123');
        expect(parsed.readyTimeoutMs).toBe(12345);
        expect(parsed.pollIntervalMs).toBe(250);
        expect(parsed.keepContainer).toBe(true);
    });

    it('generates a unique password that satisfies the Db2 policy', () => {
        const first = harness.generatePassword();
        const second = harness.generatePassword();

        expect(first).not.toBe(second);
        expect(first.length).toBeGreaterThanOrEqual(16);
        expect(first).toMatch(/[a-z]/);
        expect(first).toMatch(/[A-Z]/);
        expect(first).toMatch(/[0-9]/);
        expect(first).toMatch(/[^A-Za-z0-9]/);
    });

    it('sanitises container names for Docker', () => {
        expect(harness.buildContainerName('JB DB2/LIVE', 'ABC_123')).toBe('jb-db2-live-abc_123');
        expect(harness.buildContainerName('--bad--', 'x'.repeat(80))).toHaveLength(63);
    });

    it('publishes only a random loopback port and never reuses a container name', () => {
        const args = harness.buildDockerRunArgs(options({ containerName: 'jb-db2-live-test' }));

        expect(args.slice(0, 3)).toEqual(['run', '--detach', '--name']);
        expect(args).toContain('jb-db2-live-test');
        expect(args).toContain('--privileged=true');
        expect(args.join(' ')).toContain('127.0.0.1::50000');
        expect(args).toContain('LICENSE=accept');
        expect(args).toContain('DBNAME=JBLTEST');
        expect(args[args.length - 1]).toBe(harness.DEFAULT_IMAGE);
    });

    it('parses Docker port output for IPv4 and IPv6 bindings', () => {
        expect(harness.parseHostPort('127.0.0.1:32768')).toBe(32768);
        expect(harness.parseHostPort('[::]:49152\n')).toBe(49152);
        expect(harness.parseHostPort('')).toBeUndefined();
        expect(harness.parseHostPort('127.0.0.1:not-a-port')).toBeUndefined();
        expect(harness.parseHostPort('127.0.0.1:70000')).toBeUndefined();
    });

    it('builds the live Jest environment with the strict ephemeral marker', () => {
        const env = harness.buildJestEnv(options({ password: 'Secret9!' }), 32768);

        expect(env).toEqual(expect.objectContaining({
            DB2_LIVE_TEST_HOST: '127.0.0.1',
            DB2_LIVE_TEST_PORT: '32768',
            DB2_LIVE_TEST_DATABASE: 'JBLTEST',
            DB2_LIVE_TEST_USER: 'db2inst1',
            DB2_LIVE_TEST_PASSWORD: 'Secret9!',
            DB2_LIVE_FIXTURE_SCHEMA: 'JBL_LIVE',
            DB2_LIVE_TEST_REQUIRED: 'true',
            JUSTYBASE_DB2_EPHEMERAL: '1',
        }));
        expect(harness.isStrictEphemeral(env)).toBe(true);
        expect(harness.isStrictEphemeral({})).toBe(false);
    });

    it('runs both live suites in one Jest process', () => {
        const args = harness.buildJestArgs();

        expect(args).toContain('--runInBand');
        expect(args).toContain('src/__tests__/integration/db2.integration.test.ts');
        expect(args).toContain('src/__tests__/integration/db2Runstats.live.integration.test.ts');
    });

    it('seeds the full persistent fixture expected by the live suite', () => {
        const sql = harness.buildFixtureSql('JBL_LIVE');

        expect(sql.startsWith('--#SET TERMINATOR @')).toBe(true);
        expect(sql).toContain('CREATE SCHEMA JBL_LIVE@');
        expect(sql).toContain('JBL_EMPLOYEES');
        expect(sql).toContain('JBL_ORDERS');
        expect(sql).toContain('JBL_ALIAS_CUSTOMERS');
        expect(sql).toContain('JBL_V_EMP_DEPT');
        expect(sql).toContain('JBL_V_CUSTOMER_ORDER_SUM');
        expect(sql).toContain('JBL_FIXTURE_ORDER_SUM_MARKER');
        expect(sql).toContain('JBL_SALES_FACT');
        expect(sql).toContain('JBL_GET_CUSTOMER_ORDER_COUNT');
        expect(sql.match(/fixture\.local/g)).toHaveLength(12);
    });

    it('rejects an unsafe fixture schema', () => {
        expect(() => harness.buildFixtureSql('JBL-LIVE')).toThrow(/Invalid Db2 fixture schema/);
    });

    it('redacts the generated password from logs', () => {
        expect(harness.redactSecret('connect Secret9! now', 'Secret9!')).toBe(
            'connect <redacted> now',
        );
        expect(harness.redactSecret('no secret', '')).toBe('no secret');
    });
});
