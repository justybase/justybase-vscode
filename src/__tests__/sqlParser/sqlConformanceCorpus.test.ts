import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    assertConformanceCasesSane,
    loadSqlConformanceCases,
    loadSqlConformanceMetadataFixture,
    resolveSqlConformanceRoot,
    selectPostgresqlCases,
    SQL_CONFORMANCE_REQUIRED_MESSAGE,
    type SqlConformanceCase,
} from './sqlConformanceCorpus';

// Contract tests for the local-only corpus loader. They use inline data and
// temporary directories, never the shared corpus, and run in standard CI.
describe('SQL conformance corpus loader contract', () => {
    const variable = 'JUSTYBASE_SQL_CONFORMANCE_PATH';
    let saved: string | undefined;
    let restoreEnv = false;

    beforeEach(() => {
        saved = process.env[variable];
        restoreEnv = Object.prototype.hasOwnProperty.call(process.env, variable);
        delete process.env[variable];
    });

    afterEach(() => {
        if (restoreEnv) process.env[variable] = saved;
        else delete process.env[variable];
    });

    it('requires JUSTYBASE_SQL_CONFORMANCE_PATH with a readable error', () => {
        expect(() => resolveSqlConformanceRoot()).toThrow(SQL_CONFORMANCE_REQUIRED_MESSAGE);
        expect(SQL_CONFORMANCE_REQUIRED_MESSAGE).toContain('JUSTYBASE_SQL_CONFORMANCE_PATH');
    });

    it('rejects a configured path without dialects/', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-conformance-'));
        process.env[variable] = empty;
        expect(() => resolveSqlConformanceRoot()).toThrow('missing dialects/');
    });

    it('loads JSONL cases and selects the PostgreSQL scope', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-conformance-'));
        fs.mkdirSync(path.join(root, 'dialects', 'postgresql', 'parser'), { recursive: true });
        fs.mkdirSync(path.join(root, 'dialects', 'common', 'parser'), { recursive: true });
        const parserCase: SqlConformanceCase = {
            id: 'postgresql.parser.select.001', dialect: 'postgresql', sql: 'SELECT 1',
            contract: 'parser', expect: { valid: true },
        };
        const commonCase: SqlConformanceCase = {
            id: 'common.parser.values.001', dialect: 'common', appliesTo: ['postgresql'],
            sql: 'VALUES 1', contract: 'parser', expect: { valid: true },
        };
        const otherCase: SqlConformanceCase = {
            id: 'netezza.parser.select.001', dialect: 'netezza', sql: 'SELECT 1',
            contract: 'parser', expect: { valid: true },
        };
        fs.writeFileSync(path.join(root, 'dialects', 'postgresql', 'parser', 'cases.jsonl'),
            [parserCase, otherCase].map(testCase => JSON.stringify(testCase)).join('\n') + '\n');
        fs.writeFileSync(path.join(root, 'dialects', 'common', 'parser', 'cases.jsonl'),
            JSON.stringify(commonCase) + '\n');
        process.env[variable] = root;

        expect(resolveSqlConformanceRoot()).toBe(root);
        const loaded = loadSqlConformanceCases(root);
        expect(loaded).toHaveLength(3);
        const selected = selectPostgresqlCases(loaded);
        expect(selected.map(testCase => testCase.id)).toEqual([
            'common.parser.values.001',
            'postgresql.parser.select.001',
        ]);
        expect(() => assertConformanceCasesSane(selected)).not.toThrow();
        expect(() => assertConformanceCasesSane([...selected, selected[0]])).toThrow();
    });

    it('reports a missing metadata fixture with a readable error', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-conformance-'));
        fs.mkdirSync(path.join(root, 'dialects'), { recursive: true });
        process.env[variable] = root;
        expect(() => loadSqlConformanceMetadataFixture(root, 'postgresql/authoring')).toThrow(
            'postgresql/authoring',
        );
    });
});
