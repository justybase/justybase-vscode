jest.unmock('chevrotain');
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import {
    assertConformanceCasesSane,
    loadSqlConformanceCases,
    resolveSqlConformanceRoot,
    selectPostgresqlCases,
} from './sqlConformanceCorpus';

// Local-only PostgreSQL conformance: reads the sibling JustyBase.SqlConformance
// checkout via JUSTYBASE_SQL_CONFORMANCE_PATH. Never uses committed fixtures.
const cases = selectPostgresqlCases(loadSqlConformanceCases(resolveSqlConformanceRoot()))
    .filter(testCase => testCase.contract === 'parser');

describe('PostgreSQL conformance (local)', () => {
  it('loads a non-empty corpus with unique case IDs', () => {
    assertConformanceCasesSane(cases);
  });
  it.each(cases)('$id', ({ sql, expect: expected }) => {
    // Live-baseline cases use the fixture placeholder; render it as the shared live test does.
    const result = parseSqlStatements({ sql: sql.replace(/\{\{cf\}\}/g, 'JB_CF_FIXTURE'), databaseKind: 'postgresql' });
    if (expected.valid) expect([...result.lexResult.errors, ...result.actionableParserErrors].map(e => e.message)).toEqual([]);
    expect({ sql, valid: result.lexResult.errors.length === 0 && result.actionableParserErrors.length === 0 }).toEqual({ sql, valid: expected.valid });
  });
});
