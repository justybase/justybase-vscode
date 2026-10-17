jest.unmock('chevrotain');

import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import {
    assertConformanceCasesSane,
    loadSqlConformanceCases,
    resolveSqlConformanceRoot,
    type SqlConformanceCase,
} from './sqlConformanceCorpus';

// Local-only SQL conformance: reads the sibling JustyBase.SqlConformance
// checkout via JUSTYBASE_SQL_CONFORMANCE_PATH. Never uses committed fixtures.
const cases = loadSqlConformanceCases(resolveSqlConformanceRoot()).filter(testCase =>
    (testCase.tags ?? []).includes('multidialect-live-baseline'),
) as (SqlConformanceCase & {
    expect: { valid: boolean };
    verification: { status: string };
})[];

describe('Shared SQL live baseline (local conformance)', () => {
    it('loads a non-empty corpus with unique case IDs', () => {
        assertConformanceCasesSane(cases);
    });

    it.each(cases)('$id', testCase => {
        expect(testCase.verification.status).toBe('oracleVerified');
        const result = parseSqlStatements({
            sql: testCase.sql.replace(/\{\{cf\}\}/g, 'JB_CF_FIXTURE'),
            databaseKind: testCase.dialect,
        });
        const errors = [...result.lexResult.errors, ...result.actionableParserErrors];
        if (testCase.expect.valid) {
            expect(errors.map(error => error.message)).toEqual([]);
            expect(result.cst).toBeDefined();
        } else {
            expect(errors.length).toBeGreaterThan(0);
        }
    });
});
