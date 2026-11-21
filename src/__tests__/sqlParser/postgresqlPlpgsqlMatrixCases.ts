/**
 * Live-proven PL/pgSQL structural matrix.
 *
 * `valid` means PostgreSQL accepts `CREATE FUNCTION`/`CREATE PROCEDURE`/`DO`
 * for the case. `codes` is the static analyzer verdict (`[]` means clean).
 * `runtimeRejects` marks a syntactically valid body that fails when executed,
 * which is how PGP007 (missing RETURN for a non-void function) is verified.
 *
 * The live suite replaces `{{fn}}` with a unique name inside a transactional
 * fixture schema; the unit suite replaces it with a stable name.
 */
export interface PostgresqlPlpgsqlMatrixCase {
    id: string;
    sql: string;
    valid: boolean;
    codes: string[];
    runtimeRejects?: boolean;
}

const fn = (body: string, returns = 'void'): string =>
    `CREATE FUNCTION public.{{fn}}() RETURNS ${returns} LANGUAGE plpgsql AS $$ ${body} $$`;

export const POSTGRESQL_PLPGSQL_MATRIX_CASES: readonly PostgresqlPlpgsqlMatrixCase[] = [
    { id: 'simple-block', sql: fn('BEGIN RETURN 1; END', 'integer'), valid: true, codes: [] },
    { id: 'procedure', sql: 'CREATE PROCEDURE public.{{fn}}() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$', valid: true, codes: [] },
    { id: 'void-no-return', sql: fn('BEGIN NULL; END', 'void'), valid: true, codes: [] },
    { id: 'trigger-function', sql: fn('BEGIN RETURN NEW; END', 'trigger'), valid: true, codes: [] },
    { id: 'nested-labelled-blocks', sql: fn('<<outer>> BEGIN <<inner>> BEGIN NULL; END inner; END outer;'), valid: true, codes: [] },
    { id: 'if-elsif-else', sql: fn('BEGIN IF true THEN NULL; ELSIF false THEN NULL; ELSE NULL; END IF; END'), valid: true, codes: [] },
    { id: 'elseif-synonym', sql: fn('BEGIN IF true THEN NULL; ELSEIF false THEN NULL; END IF; END'), valid: true, codes: [] },
    { id: 'labelled-loop', sql: fn('BEGIN <<l>> LOOP EXIT l; END LOOP l; END'), valid: true, codes: [] },
    { id: 'while-loop', sql: fn('BEGIN WHILE true LOOP EXIT; END LOOP; END'), valid: true, codes: [] },
    { id: 'for-loop', sql: fn('BEGIN FOR i IN 1..10 LOOP NULL; END LOOP; END'), valid: true, codes: [] },
    { id: 'foreach-loop', sql: fn('DECLARE x integer; BEGIN FOREACH x IN ARRAY ARRAY[1] LOOP NULL; END LOOP; END'), valid: true, codes: [] },
    { id: 'case-expression', sql: fn('BEGIN RETURN CASE WHEN true THEN 1 ELSE 0 END; END', 'integer'), valid: true, codes: [] },
    { id: 'case-statement', sql: fn('BEGIN CASE 1 WHEN 1 THEN NULL; ELSE NULL; END CASE; END'), valid: true, codes: [] },
    { id: 'exception-handler', sql: fn('BEGIN NULL; EXCEPTION WHEN OTHERS THEN NULL; END'), valid: true, codes: [] },
    { id: 'nested-exception-handler', sql: fn('BEGIN BEGIN NULL; EXCEPTION WHEN OTHERS THEN NULL; END; END'), valid: true, codes: [] },
    { id: 'declare-block', sql: fn('DECLARE x integer := 1; BEGIN RETURN x; END', 'integer'), valid: true, codes: [] },
    { id: 'nested-declare', sql: fn('BEGIN DECLARE y integer := 1; BEGIN NULL; END; END'), valid: true, codes: [] },
    { id: 'nested-block-followed-by-if', sql: fn('BEGIN BEGIN NULL; END; IF true THEN NULL; END IF; END'), valid: true, codes: [] },
    { id: 'nested-block-followed-by-loop', sql: fn('BEGIN BEGIN NULL; END; LOOP EXIT; END LOOP; END'), valid: true, codes: [] },
    { id: 'bit-shift-operators', sql: fn('BEGIN PERFORM 1 << 2 >> 1; END'), valid: true, codes: [] },
    { id: 'merge-inside-body', sql: fn('BEGIN MERGE INTO items i USING items s ON i.id = s.id WHEN MATCHED THEN UPDATE SET payload = s.payload; END'), valid: true, codes: [] },
    { id: 'return-query', sql: fn('BEGIN RETURN QUERY SELECT 1; END', 'TABLE(n integer)'), valid: true, codes: [] },
    { id: 'setof-function', sql: fn('BEGIN RETURN QUERY SELECT 1; END', 'SETOF integer'), valid: true, codes: [] },
    { id: 'do-block', sql: 'DO $$ BEGIN NULL; END $$', valid: true, codes: [] },
    { id: 'do-language', sql: 'DO LANGUAGE plpgsql $$ BEGIN NULL; END $$', valid: true, codes: [] },
    { id: 'comments-and-strings', sql: fn("BEGIN -- IF LOOP CASE\n RAISE NOTICE 'BEGIN END IF'; END"), valid: true, codes: [] },
    { id: 'nested-dollar-quoted-string', sql: fn('BEGIN EXECUTE $q$ BEGIN LOOP $q$; END'), valid: true, codes: [] },
    { id: 'sql-language-body', sql: 'CREATE FUNCTION public.{{fn}}() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$', valid: true, codes: [] },
    { id: 'missing-return-warning', sql: fn('BEGIN NULL; END', 'integer'), valid: true, codes: ['PGP007'], runtimeRejects: true },

    { id: 'missing-end', sql: fn('BEGIN RETURN 1;', 'integer'), valid: false, codes: ['PGP001'] },
    { id: 'declare-without-begin', sql: 'DO $$ DECLARE x integer; END $$', valid: false, codes: ['PGP006'] },
    { id: 'extra-end', sql: fn('BEGIN NULL; END; END;'), valid: false, codes: ['PGP002'] },
    { id: 'missing-end-if', sql: fn('BEGIN IF true THEN NULL; END'), valid: false, codes: ['PGP003'] },
    { id: 'extra-end-if', sql: fn('BEGIN END IF; END'), valid: false, codes: ['PGP003'] },
    { id: 'if-without-then', sql: fn('BEGIN IF true END IF; END'), valid: false, codes: ['PGP003'] },
    { id: 'missing-end-loop', sql: fn('BEGIN LOOP NULL; END'), valid: false, codes: ['PGP004'] },
    { id: 'extra-end-loop', sql: fn('BEGIN END LOOP; END'), valid: false, codes: ['PGP004'] },
    { id: 'unclosed-case', sql: fn('BEGIN CASE WHEN true THEN NULL;'), valid: false, codes: ['PGP005', 'PGP001'] },
    { id: 'extra-end-case', sql: fn('BEGIN END CASE; END'), valid: false, codes: ['PGP005'] },
    { id: 'no-begin', sql: 'DO $$ NULL; $$', valid: false, codes: ['PGP001'] },
    { id: 'empty-body', sql: 'DO $$ $$', valid: false, codes: ['PGP001'] },
    { id: 'misplaced-exception', sql: fn('BEGIN IF true THEN EXCEPTION WHEN OTHERS THEN NULL; END IF; END'), valid: false, codes: ['PGP008'] },
    { id: 'when-without-exception', sql: fn('BEGIN WHEN OTHERS THEN NULL; END'), valid: false, codes: ['PGP008'] },
    { id: 'elsif-without-if', sql: fn('BEGIN ELSIF true THEN NULL; END'), valid: false, codes: ['PGP009'] },
    { id: 'else-without-if', sql: fn('BEGIN ELSE NULL; END'), valid: false, codes: ['PGP009'] },
];
