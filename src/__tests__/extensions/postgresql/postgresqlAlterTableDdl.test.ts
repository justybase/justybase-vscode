import { describe, expect, it } from '@jest/globals';
import {
    buildPostgresqlAlterTableSql,
    hasPostgresqlAlterTableChanges,
    renderPostgresqlDefaultValue,
} from '../../../../extensions/postgresql/src/postgresqlAlterTableDdl';
import type {
    PostgresqlAlterTableDesign,
    PostgresqlAlterTableDesignerColumn,
    PostgresqlAlterTableDesignerInitialContext,
} from '../../../contracts/webviews/postgresqlAlterTableDesignerContracts';

function column(overrides: Partial<PostgresqlAlterTableDesignerColumn> = {}): PostgresqlAlterTableDesignerColumn {
    return {
        name: 'id',
        type: 'bigint',
        notNull: true,
        defaultValue: '',
        comment: '',
        ordinal: 1,
        isPrimaryKey: true,
        isForeignKey: false,
        ...overrides,
    };
}

function context(overrides: Partial<PostgresqlAlterTableDesignerInitialContext> = {}): PostgresqlAlterTableDesignerInitialContext {
    return {
        schema: 'public',
        tableName: 'orders',
        qualifiedTable: 'public.orders',
        columns: [
            column(),
            column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: '', comment: '', ordinal: 2, isPrimaryKey: false }),
        ],
        options: {
            tablespace: '',
            fillfactor: '90',
            comment: 'customer orders',
        },
        tablespaces: ['pg_default', 'fast_ssd'],
        ...overrides,
    };
}

function design(overrides: Partial<PostgresqlAlterTableDesign> = {}): PostgresqlAlterTableDesign {
    return {
        columns: [
            column(),
            column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: '', comment: '', ordinal: 2, isPrimaryKey: false }),
        ],
        options: {
            tablespace: '',
            fillfactor: '90',
            comment: 'customer orders',
        },
        ...overrides,
    };
}

describe('PostgreSQL alter table DDL', () => {
    it('returns an empty statement when nothing changed', () => {
        expect(buildPostgresqlAlterTableSql(context(), design())).toBe('');
        expect(hasPostgresqlAlterTableChanges(context(), design())).toBe(false);
    });

    it('emits ADD COLUMN for new columns with type, NOT NULL, and default', () => {
        const withAdd = design({
            columns: [
                ...design().columns,
                column({ name: 'email', type: 'character varying(255)', notNull: true, defaultValue: "'none'", comment: '', ordinal: 3, isPrimaryKey: false, isForeignKey: false }),
            ],
        });
        expect(buildPostgresqlAlterTableSql(context(), withAdd)).toBe(
            "ALTER TABLE public.orders ADD COLUMN email character varying(255) NOT NULL DEFAULT 'none';",
        );
    });

    it('emits COMMENT ON COLUMN for comments on newly added columns', () => {
        const withAdd = design({
            columns: [
                ...design().columns,
                column({ name: 'email', type: 'character varying(255)', notNull: false, defaultValue: '', comment: 'contact address', ordinal: 3, isPrimaryKey: false, isForeignKey: false }),
            ],
        });
        expect(buildPostgresqlAlterTableSql(context(), withAdd)).toBe(
            'ALTER TABLE public.orders ADD COLUMN email character varying(255);\n\n'
            + "COMMENT ON COLUMN public.orders.email IS 'contact address';",
        );
    });

    it('emits separate ALTER COLUMN actions for type, nullability, and default changes', () => {
        const modified = design({
            columns: [
                column(),
                column({ name: 'CUSTOMER_NAME', type: 'text', notNull: true, defaultValue: "''", comment: '', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        expect(buildPostgresqlAlterTableSql(context(), modified)).toBe(
            'ALTER TABLE public.orders\n'
            + '    ALTER COLUMN "CUSTOMER_NAME" TYPE text,\n'
            + '    ALTER COLUMN "CUSTOMER_NAME" SET NOT NULL,\n'
            + "    ALTER COLUMN \"CUSTOMER_NAME\" SET DEFAULT '';",
        );
    });

    it('emits SET NOT NULL and SET DEFAULT when applied', () => {
        const modified = design({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: true, defaultValue: "'pending'", comment: '', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        const ddl = buildPostgresqlAlterTableSql(context(), modified);
        expect(ddl).toContain('ALTER COLUMN customer_name SET NOT NULL');
        expect(ddl).toContain('ALTER COLUMN customer_name SET DEFAULT \'pending\'');
    });

    it('emits DROP NOT NULL and DROP DEFAULT when a constrained column is relaxed', () => {
        const constrained = context({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: true, defaultValue: "'pending'::character varying", comment: '', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        const relaxed = design({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: '', comment: '', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        const ddl = buildPostgresqlAlterTableSql(constrained, relaxed);
        expect(ddl).toBe(
            'ALTER TABLE public.orders\n'
            + '    ALTER COLUMN customer_name DROP NOT NULL,\n'
            + '    ALTER COLUMN customer_name DROP DEFAULT;',
        );
    });

    it('emits COMMENT ON COLUMN for column comment changes', () => {
        const modified = design({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: '', comment: 'buyer name', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        expect(buildPostgresqlAlterTableSql(context(), modified)).toBe(
            "COMMENT ON COLUMN public.orders.customer_name IS 'buyer name';",
        );
    });

    it('emits DROP COLUMN and rejects PRIMARY KEY drops', () => {
        const dropped = design({ columns: [design().columns[0]] });
        expect(buildPostgresqlAlterTableSql(context(), dropped)).toBe(
            'ALTER TABLE public.orders DROP COLUMN customer_name;',
        );

        const pkDropped = design({ columns: [design().columns[1]] });
        expect(() => buildPostgresqlAlterTableSql(context(), pkDropped))
            .toThrow('PRIMARY KEY column "id" cannot be dropped');
    });

    it('emits SET TABLESPACE, SET/RESET fillfactor, and COMMENT ON TABLE', () => {
        const changed = design({
            columns: [design().columns[0]],
            options: { tablespace: 'fast_ssd', fillfactor: '70', comment: 'archived orders' },
        });
        expect(buildPostgresqlAlterTableSql(context(), changed)).toBe(
            'ALTER TABLE public.orders DROP COLUMN customer_name;\n\n'
            + 'ALTER TABLE public.orders SET TABLESPACE fast_ssd;\n\n'
            + 'ALTER TABLE public.orders SET (fillfactor = 70);\n\n'
            + "COMMENT ON TABLE public.orders IS 'archived orders';",
        );

        const reset = design({
            options: { tablespace: '', fillfactor: '', comment: 'customer orders' },
        });
        expect(buildPostgresqlAlterTableSql(context(), reset)).toBe(
            'ALTER TABLE public.orders RESET (fillfactor);',
        );
    });

    it('validates the design before generating DDL', () => {
        expect(() => buildPostgresqlAlterTableSql(context(), design({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: '', comment: '', ordinal: 2, isPrimaryKey: false }),
                column({ name: 'email', type: 'text', notNull: false, defaultValue: '', comment: '', ordinal: 3, isPrimaryKey: false }),
                column({ name: 'EMAIL', type: 'text', notNull: false, defaultValue: '', comment: '', ordinal: 4, isPrimaryKey: false }),
            ],
        }))).toThrow('defined more than once');

        expect(() => buildPostgresqlAlterTableSql(context(), design({
            columns: [column({ type: 'text; DROP TABLE x' })],
        }))).toThrow('separators or comments');

        expect(() => buildPostgresqlAlterTableSql(context(), design({
            options: { tablespace: 'fast ssd; DROP', fillfactor: '90', comment: '' },
        }))).toThrow('only contain letters');
    });

    it('renders default values with PostgreSQL-aware quoting', () => {
        expect(renderPostgresqlDefaultValue("'pending'::character varying", 'character varying(120)')).toBe("'pending'::character varying");
        expect(renderPostgresqlDefaultValue('CURRENT_TIMESTAMP', 'timestamp without time zone')).toBe('CURRENT_TIMESTAMP');
        expect(renderPostgresqlDefaultValue('now()', 'timestamp without time zone')).toBe('now()');
        expect(renderPostgresqlDefaultValue('42', 'integer')).toBe('42');
        expect(renderPostgresqlDefaultValue('NULL', 'integer')).toBe('NULL');
        expect(renderPostgresqlDefaultValue('true', 'boolean')).toBe('true');
        expect(renderPostgresqlDefaultValue('pending', 'character varying(120)')).toBe("'pending'");
        expect(renderPostgresqlDefaultValue('', 'integer')).toBe('');
    });

    it('keeps unchanged pg_get_expr defaults stable across round trips', () => {
        const withCastDefault = context({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: "'pending'::character varying", comment: '', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        const sameDesign = design({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'character varying(120)', notNull: false, defaultValue: "'pending'::character varying", comment: '', ordinal: 2, isPrimaryKey: false }),
            ],
        });
        expect(buildPostgresqlAlterTableSql(withCastDefault, sameDesign)).toBe('');
    });
});