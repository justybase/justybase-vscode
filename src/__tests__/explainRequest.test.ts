import { registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { resetDatabaseDialectTestingState } from './dialectTestUtils';
import { db2Dialect } from '../../extensions/db2/src/db2Dialect';
import { db2ExplainProvider } from '../../extensions/db2/src/db2ExplainParser';
import {
    buildExplainRequest,
    formatExplainErrorForDialect,
    normalizeExplainOutputForDisplay,
    stripExplainPrefix,
} from '../core/explain/explainRequest';

describe('explainRequest', () => {
    afterEach(() => {
        resetDatabaseDialectTestingState();
    });

    it('strips a user-typed EXPLAIN prefix', () => {
        expect(stripExplainPrefix('SELECT 1 FROM T')).toBe('SELECT 1 FROM T');
        expect(stripExplainPrefix('EXPLAIN SELECT 1 FROM T')).toBe('SELECT 1 FROM T');
        expect(stripExplainPrefix('explain verbose SELECT 1')).toBe('SELECT 1');
        expect(stripExplainPrefix('EXPLAIN QUERY PLAN SELECT 1')).toBe('SELECT 1');
        // Db2/Oracle form, so re-running an explained statement does not double it.
        expect(stripExplainPrefix('EXPLAIN PLAN FOR SELECT 1')).toBe('SELECT 1');
        expect(stripExplainPrefix('explain plan select 1')).toBe('select 1');
    });

    it('falls back to the generic EXPLAIN form without a dialect provider', () => {
        expect(buildExplainRequest('SELECT 1', 'netezza')).toEqual({
            explainSql: 'EXPLAIN SELECT 1',
        });
        expect(buildExplainRequest('EXPLAIN SELECT 1', 'netezza', { verbose: true })).toEqual({
            explainSql: 'EXPLAIN VERBOSE SELECT 1',
        });
    });

    it('uses the dialect provider, including its retrieval statement', () => {
        registerDatabaseDialect(db2Dialect);

        const request = buildExplainRequest('SELECT 1 FROM SYSIBM.SYSDUMMY1', 'db2', { verbose: true });

        expect(request.explainSql).toBe('EXPLAIN PLAN FOR SELECT 1 FROM SYSIBM.SYSDUMMY1');
        expect(request.retrieveQuery).toContain('EXPLAIN_OPERATOR');
    });

    it('normalizes persisted-plan JSON through the provider', () => {
        registerDatabaseDialect(db2Dialect);
        const rows = [
            { OPERATOR_ID: 2, OPERATOR_TYPE: 'RETURN', TOTAL_COST: 8, STREAM_COUNT: 1, COLUMN_COUNT: 1, PARENT_ID: null },
            { OPERATOR_ID: 1, OPERATOR_TYPE: 'TBSCAN', TOTAL_COST: 4, STREAM_COUNT: 10, COLUMN_COUNT: 2, PARENT_ID: 2 },
        ];

        const normalized = normalizeExplainOutputForDisplay(JSON.stringify(rows), 'db2');

        expect(normalized).toContain('RETURN');
        expect(normalized).toContain('TBSCAN');
        expect(normalizeExplainOutputForDisplay('unchanged', 'netezza')).toBe('unchanged');
    });

    it('delegates actionable EXPLAIN errors to the provider', () => {
        registerDatabaseDialect(db2Dialect);

        expect(
            formatExplainErrorForDialect('SQL0204N EXPLAIN_OPERATOR undefined name', 'db2'),
        ).toContain('EXPLAIN.DDL');
        expect(formatExplainErrorForDialect('SQL0805N package not found', 'db2')).toBe(
            'SQL0805N package not found',
        );
        expect(formatExplainErrorForDialect('SQL0204N EXPLAIN_OPERATOR undefined name', 'netezza')).toBe(
            'SQL0204N EXPLAIN_OPERATOR undefined name',
        );
    });

    it('keeps the Db2 provider wired on the dialect', () => {
        expect(db2Dialect.advancedFeatures?.explain).toBe(db2ExplainProvider);
    });
});
