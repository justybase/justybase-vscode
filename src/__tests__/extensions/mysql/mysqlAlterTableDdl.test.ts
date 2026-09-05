import { describe, expect, it } from '@jest/globals';
import {
    buildMysqlAlterTableSql,
    buildMysqlColumnDefinitionSql,
    hasMysqlAlterTableChanges,
    renderMysqlDefaultValue,
} from '../../../../extensions/mysql/src/mysqlAlterTableDdl';
import type {
    MysqlAlterTableDesign,
    MysqlAlterTableDesignerColumn,
    MysqlAlterTableDesignerInitialContext,
} from '../../../contracts/webviews/mysqlAlterTableDesignerContracts';

function column(overrides: Partial<MysqlAlterTableDesignerColumn> = {}): MysqlAlterTableDesignerColumn {
    return {
        name: 'id',
        type: 'bigint',
        notNull: true,
        defaultValue: '',
        autoIncrement: true,
        comment: '',
        ordinal: 1,
        isPrimaryKey: true,
        isForeignKey: false,
        ...overrides,
    };
}

function context(overrides: Partial<MysqlAlterTableDesignerInitialContext> = {}): MysqlAlterTableDesignerInitialContext {
    return {
        schema: 'sales',
        tableName: 'orders',
        qualifiedTable: 'sales.orders',
        serverVersion: '8.0.36',
        columns: [
            column(),
            column({ name: 'customer_name', type: 'varchar(120)', notNull: false, autoIncrement: false, ordinal: 2, isPrimaryKey: false }),
        ],
        options: {
            engine: 'InnoDB',
            charset: 'utf8mb4',
            collation: 'utf8mb4_0900_ai_ci',
            autoIncrement: '1000',
            comment: 'customer orders',
        },
        charsets: ['utf8', 'utf8mb4'],
        collations: [
            { name: 'utf8mb4_0900_ai_ci', charset: 'utf8mb4' },
            { name: 'utf8mb4_general_ci', charset: 'utf8mb4' },
        ],
        ...overrides,
    };
}

function design(overrides: Partial<MysqlAlterTableDesign> = {}): MysqlAlterTableDesign {
    return {
        columns: [
            column(),
            column({ name: 'customer_name', type: 'varchar(120)', notNull: false, autoIncrement: false, ordinal: 2, isPrimaryKey: false }),
        ],
        options: {
            engine: 'InnoDB',
            charset: 'utf8mb4',
            collation: 'utf8mb4_0900_ai_ci',
            autoIncrement: '1000',
            comment: 'customer orders',
        },
        ...overrides,
    };
}

describe('MySQL alter table DDL', () => {
    it('returns an empty statement when nothing changed', () => {
        expect(buildMysqlAlterTableSql(context(), design())).toBe('');
        expect(hasMysqlAlterTableChanges(context(), design())).toBe(false);
    });

    it('emits ADD COLUMN for new columns', () => {
        const designWithAdd = design({
            columns: [
                ...design().columns,
                column({ name: 'email', type: 'varchar(255)', notNull: false, autoIncrement: false, ordinal: 3, isPrimaryKey: false, isForeignKey: false }),
            ],
        });
        expect(buildMysqlAlterTableSql(context(), designWithAdd)).toBe(
            'ALTER TABLE sales.orders\n'
            + '    ADD COLUMN email varchar(255) NULL;',
        );
    });

    it('emits MODIFY COLUMN only for changed columns, matched case-insensitively', () => {
        const modified = design({
            columns: [
                column(),
                column({ name: 'CUSTOMER_NAME', type: 'varchar(200)', notNull: true, autoIncrement: false, ordinal: 2, isPrimaryKey: false }),
            ],
        });
        expect(buildMysqlAlterTableSql(context(), modified)).toBe(
            'ALTER TABLE sales.orders\n'
            + '    MODIFY COLUMN CUSTOMER_NAME varchar(200) NOT NULL;',
        );
    });

    it('emits MODIFY COLUMN for nullability, default, auto_increment, and comment changes', () => {
        const modified = design({
            columns: [
                column(),
                column({
                    name: 'customer_name',
                    type: 'varchar(120)',
                    notNull: false,
                    defaultValue: "'pending'",
                    autoIncrement: false,
                    comment: 'buyer name',
                    ordinal: 2,
                    isPrimaryKey: false,
                }),
            ],
        });
        const ddl = buildMysqlAlterTableSql(context(), modified);
        expect(ddl).toContain('MODIFY COLUMN customer_name varchar(120) NULL DEFAULT \'pending\' COMMENT \'buyer name\';');
    });

    it('emits DROP COLUMN for removed columns and rejects PRIMARY KEY drops', () => {
        const dropped = design({ columns: [design().columns[0]] });
        expect(buildMysqlAlterTableSql(context(), dropped)).toBe(
            'ALTER TABLE sales.orders\n'
            + '    DROP COLUMN customer_name;',
        );

        const pkDropped = design({ columns: [design().columns[1]] });
        expect(() => buildMysqlAlterTableSql(context(), pkDropped))
            .toThrow('PRIMARY KEY column "id" cannot be dropped');
    });

    it('emits ENGINE, DEFAULT CHARACTER SET, COLLATE, AUTO_INCREMENT, and COMMENT options', () => {
        const changed = design({
            columns: [design().columns[0]],
            options: {
                engine: 'MyISAM',
                charset: 'utf8',
                collation: 'utf8_general_ci',
                autoIncrement: '5000',
                comment: 'archived orders',
            },
        });
        expect(buildMysqlAlterTableSql(context(), changed)).toBe(
            'ALTER TABLE sales.orders\n'
            + '    DROP COLUMN customer_name,\n'
            + '    ENGINE = MyISAM,\n'
            + '    COLLATE = utf8_general_ci,\n'
            + '    DEFAULT CHARACTER SET = utf8,\n'
            + '    AUTO_INCREMENT = 5000,\n'
            + '    COMMENT = \'archived orders\';',
        );
    });

    it('ignores an empty AUTO_INCREMENT field so it never emits an invalid clause', () => {
        const withEmptyAutoIncrement = design({ options: { ...design().options, autoIncrement: '' } });
        expect(buildMysqlAlterTableSql(context(), withEmptyAutoIncrement)).toBe('');
    });

    it('validates the design before generating DDL', () => {
        expect(() => buildMysqlAlterTableSql(context(), design({
            columns: [column(), column({ name: 'customer_name', type: 'varchar(120)', notNull: false, autoIncrement: false, ordinal: 2, isPrimaryKey: false })],
        }))).not.toThrow();

        expect(() => buildMysqlAlterTableSql(context(), design({
            columns: [
                column(),
                column({ name: 'customer_name', type: 'varchar(120)', notNull: false, autoIncrement: false, ordinal: 2, isPrimaryKey: false }),
                column({ name: 'email', type: 'varchar(255)', notNull: false, autoIncrement: false, ordinal: 3, isPrimaryKey: false }),
                column({ name: 'EMAIL', type: 'varchar(255)', notNull: false, autoIncrement: false, ordinal: 4, isPrimaryKey: false }),
            ],
        }))).toThrow('defined more than once');

        expect(() => buildMysqlAlterTableSql(context(), design({
            columns: [column({ type: '' })],
        }))).toThrow('Column type is required');

        expect(() => buildMysqlAlterTableSql(context(), design({
            columns: [column({ type: 'varchar(255); DROP TABLE x' })],
        }))).toThrow('statement separators or comments');

        expect(() => buildMysqlAlterTableSql(context(), design({
            options: { ...design().options, engine: 'InnoDB; DROP TABLE x' },
        }))).toThrow('only contain letters');
    });

    it('renders default values with dialect-aware quoting', () => {
        expect(renderMysqlDefaultValue('active', 'varchar(20)')).toBe("'active'");
        expect(renderMysqlDefaultValue('CURRENT_TIMESTAMP', 'datetime')).toBe('CURRENT_TIMESTAMP');
        expect(renderMysqlDefaultValue('NOW()', 'datetime')).toBe('NOW()');
        expect(renderMysqlDefaultValue('42', 'int')).toBe('42');
        expect(renderMysqlDefaultValue('NULL', 'int')).toBe('NULL');
        expect(renderMysqlDefaultValue("('a','b')", 'set')).toBe("('a','b')");
        expect(renderMysqlDefaultValue('', 'int')).toBe('');
    });

    it('builds column definitions with backtick quoting for reserved names', () => {
        expect(buildMysqlColumnDefinitionSql(column({
            name: 'order',
            type: 'int',
            notNull: false,
            defaultValue: '',
            autoIncrement: false,
        }))).toBe('`order` int NULL');
        expect(buildMysqlColumnDefinitionSql(column({
            name: 'note',
            type: 'varchar(10)',
            notNull: true,
            defaultValue: "it's",
            autoIncrement: false,
            comment: 'a note',
        }))).toBe("note varchar(10) NOT NULL DEFAULT 'it''s' COMMENT 'a note'");
    });
});