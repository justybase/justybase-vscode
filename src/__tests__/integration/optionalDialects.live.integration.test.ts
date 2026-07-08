import {
    db2Harness,
    logSkippedHarnesses,
    oracleHarness,
    postgresqlHarness,
    registerLiveIntegrationSuite,
    verticaHarness,
} from './optionalDialectIntegrationHarness';

const harnesses = [db2Harness, oracleHarness, postgresqlHarness, verticaHarness];

for (const harness of harnesses) {
    registerLiveIntegrationSuite(harness);
}

logSkippedHarnesses(
    harnesses,
    '⚠️ Optional live database tests skipped: set DB2_LIVE_TEST_*, ORACLE_LIVE_TEST_*, POSTGRES_LIVE_TEST_* or PG_LIVE_TEST_*, or VERTICA_LIVE_TEST_* environment variables and run npm run test:live:local',
);
