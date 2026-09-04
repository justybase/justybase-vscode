import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const liveDbIgnorePatterns: string[] = require('../../scripts/jestLiveDbIgnorePatterns.cjs');
const defaultJestConfig = require('../../jest.config.js') as {
    testPathIgnorePatterns?: string[];
};
const fastJestConfig = require('../../jest.fast.config.js') as {
    testPathIgnorePatterns?: string[];
};
const liveJestConfig = require('../../jest.live.config.js') as {
    testPathIgnorePatterns?: string[];
};

const legacyExternalDatabaseTests = [
    'realDatabase.integration.test.ts',
    'optionalDialects.live.integration.test.ts',
    'postgres.integration.test.ts',
    'duckdb.integration.test.ts',
    'snowflake.integration.test.ts',
    'mysql.integration.test.ts',
    'mssql.integration.test.ts',
    'oracle.integration.test.ts',
    'db2.integration.test.ts',
    'vertica.integration.test.ts',
    'access.integration.test.ts',
    'databaseTunnel.integration.test.ts',
    'databaseTunnel.live.integration.test.ts',
    'allRowsTimeoutSession.live.integration.test.ts',
    'mcpLive.integration.test.ts',
    'sasLikeMacros.e2e.test.ts',
    'linterLiveValidation.test.ts',
];

const netezzaLiveIntegrationTests = fs
    .readdirSync(path.join(__dirname, 'integration'))
    .filter(fileName => fileName.endsWith('.live.integration.test.ts'));

const externalDatabaseTestNames = [
    ...new Set([...legacyExternalDatabaseTests, ...netezzaLiveIntegrationTests]),
];

function matchesIgnorePattern(patterns: readonly string[] | undefined, fileName: string): boolean {
    return (patterns ?? []).some(pattern => new RegExp(pattern).test(fileName));
}

describe('Jest live database isolation', () => {
    it('keeps every external-database suite in the shared ignore manifest', () => {
        expect(liveDbIgnorePatterns).toEqual(expect.arrayContaining(externalDatabaseTestNames));
    });

    it('excludes external-database suites from default and fast configs', () => {
        for (const fileName of externalDatabaseTestNames) {
            expect(matchesIgnorePattern(defaultJestConfig.testPathIgnorePatterns, fileName)).toBe(true);
            expect(matchesIgnorePattern(fastJestConfig.testPathIgnorePatterns, fileName)).toBe(true);
        }
    });

    it('keeps external-database suites available through the live config', () => {
        for (const fileName of externalDatabaseTestNames) {
            expect(matchesIgnorePattern(liveJestConfig.testPathIgnorePatterns, fileName)).toBe(false);
        }
    });
});
