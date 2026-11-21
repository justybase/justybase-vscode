jest.unmock('chevrotain');

import { SqlLexer } from '../../dialects/postgresql/sql/lexer';
import {
    analyzePostgresqlRoutineBodies,
    getPostgresqlPlpgsqlDiagnostics,
} from '../../dialects/postgresql/plpgsql/postgresqlPlpgsqlDiagnostics';
import { POSTGRESQL_PLPGSQL_MATRIX_CASES } from './postgresqlPlpgsqlMatrixCases';

function analyze(sql: string): ReturnType<typeof getPostgresqlPlpgsqlDiagnostics> {
    const { tokens, errors } = SqlLexer.tokenize(sql);
    expect(errors).toEqual([]);
    return getPostgresqlPlpgsqlDiagnostics(sql, tokens);
}

function codes(sql: string): string[] {
    return analyze(sql).map(diagnostic => diagnostic.code);
}

const FUNCTION = (body: string, returns = 'void'): string =>
    `CREATE FUNCTION public.f() RETURNS ${returns} LANGUAGE plpgsql AS $$ ${body} $$`;

describe('PostgreSQL PL/pgSQL structural diagnostics', () => {
    describe('accepts valid bodies', () => {
        it.each([
            ['simple block', FUNCTION('BEGIN RETURN 1; END', 'integer')],
            ['procedure', 'CREATE PROCEDURE public.p() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$'],
            ['void function without RETURN', FUNCTION('BEGIN NULL; END', 'void')],
            ['trigger function', FUNCTION('BEGIN RETURN NEW; END', 'trigger')],
            ['event trigger function', FUNCTION('BEGIN NULL; END', 'event_trigger')],
            ['nested labelled blocks', FUNCTION('<<outer>> BEGIN <<inner>> BEGIN NULL; END inner; END outer;')],
            ['IF ELSIF ELSE', FUNCTION('BEGIN IF true THEN NULL; ELSIF false THEN NULL; ELSE NULL; END IF; END')],
            ['ELSEIF synonym', FUNCTION('BEGIN IF true THEN NULL; ELSEIF false THEN NULL; END IF; END')],
            ['labelled loop', FUNCTION('BEGIN <<l>> LOOP EXIT l; END LOOP l; END')],
            ['WHILE loop', FUNCTION('BEGIN WHILE true LOOP EXIT; END LOOP; END')],
            ['FOR loop', FUNCTION('BEGIN FOR i IN 1..10 LOOP NULL; END LOOP; END')],
            ['FOREACH loop', FUNCTION('BEGIN FOREACH x IN ARRAY ARRAY[1] LOOP NULL; END LOOP; END')],
            ['CASE expression', FUNCTION('BEGIN RETURN CASE WHEN true THEN 1 ELSE 0 END; END')],
            ['CASE statement', FUNCTION('BEGIN CASE 1 WHEN 1 THEN NULL; ELSE NULL; END CASE; END')],
            ['exception handler', FUNCTION('BEGIN NULL; EXCEPTION WHEN OTHERS THEN NULL; END')],
            ['DECLARE block', FUNCTION('DECLARE x integer := 1; BEGIN RETURN x; END')],
            ['nested DECLARE block', FUNCTION('BEGIN DECLARE y integer := 1; BEGIN NULL; END; END')],
            ['nested block followed by IF', FUNCTION('BEGIN BEGIN NULL; END; IF true THEN NULL; END IF; END')],
            ['nested block followed by LOOP', FUNCTION('BEGIN BEGIN NULL; END; LOOP EXIT; END LOOP; END')],
            ['RETURN QUERY for TABLE', FUNCTION('BEGIN RETURN QUERY SELECT 1; END', 'TABLE(n integer)')],
            ['DO block', 'DO $$ BEGIN NULL; END $$'],
            ['DO block with LANGUAGE', 'DO LANGUAGE plpgsql $$ BEGIN NULL; END $$'],
            ['comments and strings with keywords', FUNCTION("BEGIN -- IF LOOP CASE\n RAISE NOTICE 'BEGIN END IF'; END")],
            ['nested dollar-quoted string', FUNCTION('BEGIN EXECUTE $q$ BEGIN LOOP $q$; END')],
            ['bit-shift operators are not labels', FUNCTION('BEGIN PERFORM 1 << 2 >> 1; END')],
            ['MERGE inside the body', FUNCTION('BEGIN MERGE INTO items i USING items s ON i.id = s.id WHEN MATCHED THEN UPDATE SET payload = s.payload; END')],
            ['SQL-language body is not analysed', 'CREATE FUNCTION public.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$'],
        ])('%s', (_name, sql) => {
            expect(codes(sql)).toEqual([]);
        });
    });

    describe('reports structural errors', () => {
        it('reports an unclosed BEGIN', () => {
            expect(codes(FUNCTION('BEGIN RETURN 1;'))).toEqual(['PGP001']);
        });

        it('reports END without BEGIN', () => {
            expect(codes(FUNCTION('BEGIN NULL; END; END;'))).toEqual(['PGP002']);
        });

        it('reports a missing END IF', () => {
            const diagnostics = analyze(FUNCTION('BEGIN\n IF true THEN NULL;\n END'));
            expect(diagnostics.map(diagnostic => diagnostic.code)).toContain('PGP003');
            const ifDiagnostic = diagnostics.find(diagnostic => diagnostic.code === 'PGP003');
            expect(ifDiagnostic?.position.startLine).toBe(2);
        });

        it('reports END IF without IF', () => {
            expect(codes(FUNCTION('BEGIN END IF; END'))).toEqual(['PGP003']);
        });

        it('reports IF without THEN', () => {
            expect(codes(FUNCTION('BEGIN IF true END IF; END'))).toEqual(['PGP003']);
        });

        it('reports a missing END LOOP', () => {
            expect(codes(FUNCTION('BEGIN LOOP NULL; END'))).toEqual(['PGP004']);
        });

        it('reports END LOOP without LOOP', () => {
            expect(codes(FUNCTION('BEGIN END LOOP; END'))).toEqual(['PGP004']);
        });

        it('reports an unclosed CASE', () => {
            expect(codes(FUNCTION('BEGIN CASE WHEN true THEN NULL;'))).toEqual(['PGP005', 'PGP001']);
        });

        it('reports END CASE without CASE', () => {
            expect(codes(FUNCTION('BEGIN END CASE; END'))).toEqual(['PGP005']);
        });

        it('reports a non-void function without RETURN', () => {
            expect(codes(FUNCTION('BEGIN NULL; END', 'integer'))).toEqual(['PGP007']);
        });

        it('does not count RETURN inside a string or comment', () => {
            expect(codes(FUNCTION("BEGIN -- RETURN\n RAISE NOTICE 'RETURN'; END", 'integer'))).toEqual(['PGP007']);
        });

        it('reports a DECLARE block without BEGIN', () => {
            expect(codes('DO $$ DECLARE x integer; END $$')).toEqual(['PGP006']);
        });

        it('reports a body without BEGIN', () => {
            expect(codes('DO $$ NULL; $$')).toEqual(['PGP001']);
        });

        it('reports a misplaced EXCEPTION handler', () => {
            expect(codes(FUNCTION('BEGIN IF true THEN EXCEPTION WHEN OTHERS THEN NULL; END IF; END')))
                .toContain('PGP008');
        });

        it('reports WHEN without EXCEPTION', () => {
            expect(codes(FUNCTION('BEGIN WHEN OTHERS THEN NULL; END'))).toEqual(['PGP008']);
        });

        it('reports ELSIF without IF', () => {
            expect(codes(FUNCTION('BEGIN ELSIF true THEN NULL; END'))).toEqual(['PGP009']);
        });

        it('reports ELSE without IF or CASE', () => {
            expect(codes(FUNCTION('BEGIN ELSE NULL; END'))).toEqual(['PGP009']);
        });

        it('reports an empty body once', () => {
            expect(codes('DO $$ $$')).toEqual(['PGP001']);
        });
    });

    it('returns absolute offsets inside the script', () => {
        const sql = `SELECT 1;\n${FUNCTION('BEGIN RETURN 1;')}`;
        const diagnostics = analyzePostgresqlRoutineBodies(sql, SqlLexer.tokenize(sql).tokens);
        expect(diagnostics).toHaveLength(1);
        const bodyStart = sql.indexOf('BEGIN');
        expect(diagnostics[0].offset).toBe(bodyStart);
    });

    it.each(POSTGRESQL_PLPGSQL_MATRIX_CASES)('$id matches the live matrix verdict', testCase => {
        const sql = testCase.sql.split('{{fn}}').join('f');
        expect(codes(sql).sort()).toEqual([...testCase.codes].sort());
    });
});
