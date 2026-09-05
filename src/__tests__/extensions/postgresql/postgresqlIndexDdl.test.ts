import { describe, expect, it } from '@jest/globals';
import {
    buildPostgresqlCreateIndexSql,
    buildPostgresqlDropIndexSql,
    POSTGRESQL_INDEX_METHODS,
} from '../../../../extensions/postgresql/src/postgresqlIndexDdl';
import type { PostgresqlIndexDesign } from '../../../contracts/webviews/postgresqlIndexDesignerContracts';

function design(overrides: Partial<PostgresqlIndexDesign> = {}): PostgresqlIndexDesign {
    return {
        indexName: 'orders_customer_name_idx',
        method: 'btree',
        unique: false,
        keyColumns: [{ name: 'customer_name', order: 'ASC', nulls: 'LAST' }],
        includeColumns: [],
        predicate: '',
        tablespace: '',
        ...overrides,
    };
}

describe('PostgreSQL index DDL', () => {
    it('builds a standard btree index', () => {
        expect(buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design(),
        })).toBe(
            'CREATE INDEX orders_customer_name_idx ON public.orders USING btree (customer_name NULLS LAST);',
        );
    });

    it('builds UNIQUE indexes with DESC and NULLS FIRST parts', () => {
        expect(buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({
                unique: true,
                keyColumns: [
                    { name: 'created_at', order: 'DESC', nulls: 'FIRST' },
                    { name: 'id', order: 'ASC', nulls: 'LAST' },
                ],
            }),
        })).toBe(
            'CREATE UNIQUE INDEX orders_customer_name_idx ON public.orders USING btree (created_at DESC NULLS FIRST, id NULLS LAST);',
        );
    });

    it('builds INCLUDE, TABLESPACE, and WHERE predicate clauses', () => {
        expect(buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({
                method: 'gin',
                includeColumns: ['total', 'status'],
                predicate: "status = 'active'",
                tablespace: 'fast_ssd',
            }),
        })).toBe(
            "CREATE INDEX orders_customer_name_idx ON public.orders USING gin (customer_name NULLS LAST) INCLUDE (total, status) TABLESPACE fast_ssd WHERE status = 'active';",
        );
    });

    it('accepts a predicate that already starts with WHERE', () => {
        expect(buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({ predicate: 'WHERE archived = false' }),
        })).toBe(
            'CREATE INDEX orders_customer_name_idx ON public.orders USING btree (customer_name NULLS LAST) WHERE archived = false;',
        );
    });

    it('quotes identifiers when needed', () => {
        expect(buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({
                indexName: 'orders status idx',
                keyColumns: [{ name: 'order', order: 'ASC', nulls: 'LAST' }],
            }),
        })).toBe(
            'CREATE INDEX "orders status idx" ON public.orders USING btree ("order" NULLS LAST);',
        );
    });

    it('validates the design', () => {
        expect(() => buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({ indexName: '' }),
        })).toThrow('Index name is required');

        expect(() => buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({ keyColumns: [] }),
        })).toThrow('at least one key column');

        expect(() => buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({ method: 'unknown' as never }),
        })).toThrow('not supported');

        expect(() => buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({
                keyColumns: [
                    { name: 'id', order: 'ASC', nulls: 'LAST' },
                    { name: 'ID', order: 'DESC', nulls: 'FIRST' },
                ],
            }),
        })).toThrow('only be selected once');

        expect(() => buildPostgresqlCreateIndexSql({
            schema: 'public',
            tableName: 'orders',
            design: design({ predicate: "status = 'x'; DROP TABLE orders" }),
        })).toThrow('separators or comments');
    });

    it('builds DROP INDEX with schema qualification', () => {
        expect(buildPostgresqlDropIndexSql('public', 'orders status idx')).toBe(
            'DROP INDEX IF EXISTS public."orders status idx";',
        );
    });

    it('exposes the supported access methods', () => {
        expect(POSTGRESQL_INDEX_METHODS).toEqual(['btree', 'hash', 'gist', 'spgist', 'gin', 'brin']);
    });
});