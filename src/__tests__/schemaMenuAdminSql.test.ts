import {
    refreshMaterializedViewSql,
    changeTableOwnerSql,
    columnCommentSql,
    dropConstraintSql,
    dropObjectSql,
    isDroppableObjectType,
    parentTableFromDescription,
    grantGranteeError,
    grantPrivilegeOptions,
    grantSql,
    renameTableSql,
    tableCommentSql,
    truncateTableSql,
} from '../commands/schema/menuSql';
import type { MenuObjectRef } from '../commands/schema/menuSql';

const netezza: MenuObjectRef = { database: 'SALES', schema: 'ADMIN', name: 'ORDERS' };
const postgres: MenuObjectRef = { database: 'shop', schema: 'public', name: 'orders' };
const db2: MenuObjectRef = { database: 'SAMPLE', schema: 'DB2INST1', name: 'ORDERS' };
const oracle: MenuObjectRef = { database: 'ORCL', schema: 'HR', name: 'EMPLOYEES' };
const mssql: MenuObjectRef = { database: 'Shop', schema: 'dbo', name: 'Order Items' };
const mysql: MenuObjectRef = { database: 'shop', schema: 'shop', name: 'orders' };
const snowflake: MenuObjectRef = { database: 'ANALYTICS', schema: 'PUBLIC', name: 'ORDERS' };
const access: MenuObjectRef = { database: 'db', name: 'Orders' };

describe('schema menu administration SQL', () => {
    it('renames tables with each dialect statement and keeps the source container', () => {
        expect(renameTableSql('netezza', netezza, 'orders_old')).toBe('ALTER TABLE SALES.ADMIN.ORDERS RENAME TO orders_old;');
        expect(renameTableSql('postgresql', postgres, 'Orders Old')).toBe('ALTER TABLE public.orders RENAME TO "Orders Old";');
        expect(renameTableSql('db2', db2, 'ORDERS_OLD')).toBe('RENAME TABLE SAMPLE.DB2INST1.ORDERS TO ORDERS_OLD;');
        expect(renameTableSql('oracle', oracle, 'EMP_OLD')).toBe('ALTER TABLE HR.EMPLOYEES RENAME TO EMP_OLD;');
        expect(renameTableSql('mssql', mssql, 'Order Lines')).toBe(`EXEC Shop.sys.sp_rename N'dbo."Order Items"', N'Order Lines';`);
        expect(renameTableSql('mysql', mysql, 'orders_old')).toBe('RENAME TABLE shop.orders TO shop.orders_old;');
        expect(renameTableSql('snowflake', snowflake, 'ORDERS_OLD')).toBe('ALTER TABLE ANALYTICS.PUBLIC.ORDERS RENAME TO ANALYTICS.PUBLIC.ORDERS_OLD;');
        expect(() => renameTableSql('access', access, 'Old')).toThrow('not supported');
        expect(() => renameTableSql('postgresql', postgres, 'x; DROP TABLE y')).toThrow('semicolons');
        expect(() => renameTableSql('postgresql', postgres, '  ')).toThrow('Enter a new table name');
    });

    it('changes owners only where the dialect has an owner statement', () => {
        expect(changeTableOwnerSql('netezza', netezza, 'etl_user')).toBe('ALTER TABLE SALES.ADMIN.ORDERS OWNER TO etl_user;');
        expect(changeTableOwnerSql('postgresql', postgres, 'app')).toBe('ALTER TABLE public.orders OWNER TO app;');
        expect(changeTableOwnerSql('mssql', mssql, 'app_owner')).toBe(
            `EXEC Shop.sys.sp_executesql N'ALTER AUTHORIZATION ON OBJECT::dbo."Order Items" TO app_owner';`,
        );
        expect(changeTableOwnerSql('snowflake', snowflake, 'SYSADMIN')).toBe(
            'GRANT OWNERSHIP ON TABLE ANALYTICS.PUBLIC.ORDERS TO ROLE SYSADMIN COPY CURRENT GRANTS;',
        );
        for (const kind of ['oracle', 'mysql', 'db2', 'access', 'sqlite']) {
            expect(() => changeTableOwnerSql(kind, postgres, 'x')).toThrow('not supported');
        }
    });

    it('builds grants with dialect grantee syntax and privilege lists', () => {
        expect(grantSql('netezza', netezza, 'TABLE', 'LIST', 'analysts')).toBe('GRANT LIST ON SALES.ADMIN.ORDERS TO analysts;');
        expect(grantSql('db2', db2, 'TABLE', 'CONTROL', 'DBA')).toBe('GRANT CONTROL ON SAMPLE.DB2INST1.ORDERS TO DBA;');
        expect(grantSql('mysql', mysql, 'TABLE', 'SELECT', "app@'10.0.%'")).toBe(`GRANT SELECT ON shop.orders TO 'app'@'10.0.%';`);
        expect(grantSql('mysql', mysql, 'TABLE', 'ALL', 'app')).toBe(`GRANT ALL PRIVILEGES ON shop.orders TO 'app'@'%';`);
        expect(grantSql('mssql', mssql, 'TABLE', 'ALL', 'reporting')).toBe(
            `EXEC Shop.sys.sp_executesql N'GRANT SELECT, INSERT, UPDATE, DELETE ON OBJECT::dbo."Order Items" TO reporting';`,
        );
        expect(grantSql('snowflake', snowflake, 'VIEW', 'SELECT', 'ANALYST')).toBe('GRANT SELECT ON VIEW ANALYTICS.PUBLIC.ORDERS TO ROLE ANALYST;');
        expect(() => grantSql('postgresql', postgres, 'TABLE', 'LIST', 'app')).toThrow('LIST is not available');
        expect(() => grantSql('access', access, 'TABLE', 'SELECT', 'app')).toThrow('not supported');
        expect(grantPrivilegeOptions('netezza').map(option => option.label)).toContain('GROOM');
        expect(grantPrivilegeOptions('postgresql').map(option => option.label)).not.toContain('LIST');
    });

    it('validates grantees per dialect', () => {
        expect(grantGranteeError('postgresql', 'app_user')).toBeNull();
        expect(grantGranteeError('postgresql', 'app user')).toMatch('Invalid');
        expect(grantGranteeError('mysql', "'app'@'%'")).toBeNull();
        expect(grantGranteeError('mysql', 'app@localhost')).toBeNull();
        expect(grantGranteeError('mysql', 'app@@x')).toMatch('user@host');
        expect(grantGranteeError('netezza', ' ')).toMatch('cannot be empty');
    });

    it('writes table and column comments with the dialect mechanism', () => {
        expect(tableCommentSql('oracle', oracle, "Staff's data")).toBe(`COMMENT ON TABLE HR.EMPLOYEES IS 'Staff''s data';`);
        expect(columnCommentSql('postgresql', postgres, 'Order Id', 'Key')).toBe(`COMMENT ON COLUMN public.orders."Order Id" IS 'Key';`);
        expect(tableCommentSql('mysql', mysql, 'C:\\temp')).toBe(`ALTER TABLE shop.orders COMMENT = 'C:\\\\temp';`);
        const mssqlTable = tableCommentSql('mssql', mssql, "It's");
        expect(mssqlTable).toMatch(/^EXEC Shop\.sys\.sp_executesql N'IF EXISTS \(SELECT 1 FROM sys\.extended_properties/);
        expect(mssqlTable).toContain(`sp_updateextendedproperty @name = N''MS_Description'', @value = N''It''''s''`);
        expect(mssqlTable).toContain(`ELSE EXEC sys.sp_addextendedproperty`);
        expect(columnCommentSql('mssql', mssql, 'Id', 'Key')).toContain(`@level2type = N''COLUMN'', @level2name = N''Id''`);
        for (const kind of ['mysql', 'vertica', 'access', 'sqlite']) {
            expect(() => columnCommentSql(kind, postgres, 'c', 'x')).toThrow('not supported');
        }
        expect(() => tableCommentSql('access', access, 'x')).toThrow('not supported');
    });

    it('clears tables with the statement each dialect accepts', () => {
        expect(truncateTableSql('db2', db2)).toBe('TRUNCATE TABLE SAMPLE.DB2INST1.ORDERS IMMEDIATE;');
        expect(truncateTableSql('sqlite', { database: 'main', name: 'orders' })).toBe('DELETE FROM main.orders;');
        expect(truncateTableSql('access', access)).toBe('DELETE FROM db.Orders;');
        expect(truncateTableSql('mssql', mssql)).toBe('TRUNCATE TABLE Shop.dbo."Order Items";');
    });

    it('drops objects with the keyword each dialect accepts', () => {
        // Live-checked on Netezza 11.2: materialized views drop as views, external tables as tables.
        expect(dropObjectSql('netezza', 'MATERIALIZED VIEW', netezza)).toBe('DROP VIEW SALES.ADMIN.ORDERS;');
        expect(dropObjectSql('netezza', 'EXTERNAL TABLE', netezza)).toBe('DROP TABLE SALES.ADMIN.ORDERS;');
        expect(dropObjectSql('netezza', 'PROCEDURE', { ...netezza, name: 'LOAD_DAY(INTEGER, DATE)' }))
            .toBe('DROP PROCEDURE SALES.ADMIN.LOAD_DAY(INTEGER, DATE);');
        expect(dropObjectSql('netezza', 'AGGREGATE', { ...netezza, name: 'MEDIAN2(DOUBLE)' })).toBe('DROP AGGREGATE SALES.ADMIN.MEDIAN2(DOUBLE);');
        expect(dropObjectSql('db2', 'MQT', db2)).toBe('DROP TABLE DB2INST1.ORDERS;');
        expect(dropObjectSql('db2', 'NICKNAME', db2)).toBe('DROP NICKNAME DB2INST1.ORDERS;');
        expect(dropObjectSql('oracle', 'PACKAGE BODY', { ...oracle, name: 'PAYROLL' })).toBe('DROP PACKAGE BODY HR.PAYROLL;');
        expect(dropObjectSql('oracle', 'FUNCTION', { ...oracle, name: 'BONUS(NUMBER)' })).toBe('DROP FUNCTION HR.BONUS;');
        expect(dropObjectSql('mysql', 'EVENT', { ...mysql, name: 'nightly' })).toBe('DROP EVENT shop.nightly;');
        expect(dropObjectSql('snowflake', 'FILE FORMAT', { ...snowflake, name: 'CSV_FMT' })).toBe('DROP FILE FORMAT ANALYTICS.PUBLIC.CSV_FMT;');
        expect(dropObjectSql('postgresql', 'FUNCTION', { ...postgres, name: 'add_tax(numeric)' })).toBe('DROP FUNCTION public.add_tax(numeric);');
    });

    it('drops PostgreSQL triggers on their table', () => {
        expect(parentTableFromDescription('ON orders (enabled)')).toBe('orders');
        expect(parentTableFromDescription('ON "Order Items" (disabled)')).toBe('Order Items');
        expect(parentTableFromDescription('')).toBeUndefined();
        expect(dropObjectSql('postgresql', 'TRIGGER', { ...postgres, name: 'audit_trg' }, { parentTable: 'Order Items' }))
            .toBe('DROP TRIGGER audit_trg ON public."Order Items";');
        expect(() => dropObjectSql('postgresql', 'TRIGGER', { ...postgres, name: 'audit_trg' })).toThrow('trigger table is unknown');
        expect(dropObjectSql('oracle', 'TRIGGER', { ...oracle, name: 'EMP_TRG' })).toBe('DROP TRIGGER HR.EMP_TRG;');
    });

    it('refuses server-level and unknown object types', () => {
        expect(isDroppableObjectType('db2', 'SERVER')).toBe(false);
        expect(isDroppableObjectType('snowflake', 'WAREHOUSE')).toBe(false);
        expect(isDroppableObjectType('mssql', 'SEQUENCE')).toBe(false);
        expect(isDroppableObjectType('postgresql', 'index')).toBe(true);
        expect(() => dropObjectSql('db2', 'TABLESPACE', db2)).toThrow('not supported');
    });

    it('drops constraints with MySQL kind-specific clauses', () => {
        expect(dropConstraintSql('postgresql', postgres, 'orders_pkey', 'PRIMARY KEY')).toBe('ALTER TABLE public.orders DROP CONSTRAINT orders_pkey;');
        expect(dropConstraintSql('mysql', mysql, 'PRIMARY', 'PRIMARY KEY')).toBe('ALTER TABLE shop.orders DROP PRIMARY KEY;');
        expect(dropConstraintSql('mysql', mysql, 'fk_customer', 'FOREIGN KEY')).toBe('ALTER TABLE shop.orders DROP FOREIGN KEY fk_customer;');
        expect(dropConstraintSql('mysql', mysql, 'uq_code', 'UNIQUE')).toBe('ALTER TABLE shop.orders DROP INDEX uq_code;');
        expect(dropConstraintSql('mysql', mysql, 'chk_qty', 'CHECK')).toBe('ALTER TABLE shop.orders DROP CHECK chk_qty;');
        expect(dropConstraintSql('mssql', mssql, 'PK_Orders', 'PRIMARY KEY')).toBe('ALTER TABLE Shop.dbo."Order Items" DROP CONSTRAINT PK_Orders;');
    });
});

describe('refresh materialized view SQL', () => {
    const ref = { database: 'DEV', schema: 'ADMIN', name: 'MV_Sales' };

    it('uses each dialect\'s refresh statement (live-verified)', () => {
        expect(refreshMaterializedViewSql('netezza', 'MATERIALIZED VIEW', ref)).toBe('ALTER VIEW DEV.ADMIN."MV_Sales" MATERIALIZE REFRESH;');
        expect(refreshMaterializedViewSql('postgresql', 'MATERIALIZED VIEW', ref)).toBe('REFRESH MATERIALIZED VIEW ADMIN."MV_Sales";');
        expect(refreshMaterializedViewSql('postgresql', 'MATERIALIZED VIEW', ref, { concurrently: true }))
            .toBe('REFRESH MATERIALIZED VIEW CONCURRENTLY ADMIN."MV_Sales";');
        expect(refreshMaterializedViewSql('oracle', 'MATERIALIZED VIEW', ref)).toBe(`BEGIN DBMS_MVIEW.REFRESH('ADMIN."MV_Sales"'); END;`);
        // Db2 refreshes REFRESH DEFERRED MQTs; a database qualifier is rejected (SQL0108N).
        expect(refreshMaterializedViewSql('db2', 'MATERIALIZED QUERY TABLE', ref)).toBe('REFRESH TABLE ADMIN."MV_Sales";');
    });

    it('rejects object types the dialect cannot refresh', () => {
        expect(() => refreshMaterializedViewSql('mssql', 'MATERIALIZED VIEW', ref)).toThrow('not supported');
        expect(() => refreshMaterializedViewSql('db2', 'MATERIALIZED VIEW', ref)).toThrow('not supported');
        expect(() => refreshMaterializedViewSql('postgresql', 'VIEW', ref)).toThrow('not supported');
    });
});
