import {
  getDatabaseDesignerCapabilities,
  resolveDatabaseDesignerCapabilities,
  UnsupportedDesignerOperationError,
} from '@justybase/contracts';
import {
  buildAddColumnSql,
  buildCheckConstraintSql,
  buildClickHousePartitionOperationSql,
  buildClickHouseSkippingIndexSql,
  buildClickHouseSkippingIndexDropSql,
  buildDropConstraintSql,
  buildDropIndexSql,
  buildDropTriggerSql,
  buildForeignKeySql,
  buildNetezzaRoutineSql,
  buildTriggerSql,
  buildNetezzaPhysicalDesignSql,
  buildRelationalIndexSql,
  buildSnowflakeClusteringSql,
  buildSnowflakeClusteringDropSql,
  buildVerticaProjectionSql,
  buildVerticaProjectionDropSql,
  buildViewSql,
} from './objectDesignerSql';

describe('object designer SQL builders', () => {
  it('builds a guarded relational column and index change', () => {
    const capabilities = getDatabaseDesignerCapabilities('postgresql');
    expect(buildAddColumnSql('"public"."orders"', 'postgresql', {
      name: 'status',
      dataType: 'VARCHAR(32)',
      notNull: true,
      defaultExpression: "'new'",
    }, capabilities.constructs.alterTable)).toBe(
      `ALTER TABLE "public"."orders" ADD COLUMN "status" VARCHAR(32) DEFAULT 'new' NOT NULL;`,
    );
    expect(buildRelationalIndexSql('"public"."orders"', 'postgresql', {
      name: 'orders_status_idx',
      columns: 'status, created_at',
      unique: false,
    }, capabilities.constructs.indexes)).toContain('CREATE INDEX "orders_status_idx"');
    expect(buildDropIndexSql('"public"."orders"', 'postgresql', 'orders_status_idx', capabilities.constructs.indexes)).toBe('DROP INDEX "orders_status_idx";');
    expect(buildDropIndexSql('`sales`.`orders`', 'mysql', 'orders_status_idx', getDatabaseDesignerCapabilities('mysql').constructs.indexes)).toBe('DROP INDEX `orders_status_idx` ON `sales`.`orders`;');
    expect(buildDropConstraintSql('`sales`.`orders`', 'mysql', 'orders_customer_fk', 'foreignKey', getDatabaseDesignerCapabilities('mysql').constructs.foreignKeys)).toBe('ALTER TABLE `sales`.`orders` DROP FOREIGN KEY `orders_customer_fk`;');
    expect(buildDropTriggerSql('"public"."orders"', 'postgresql', { name: 'orders_audit' }, getDatabaseDesignerCapabilities('postgresql').constructs.triggers)).toBe('DROP TRIGGER "orders_audit" ON "public"."orders";');
  });

  it('rejects a generic index builder when the dialect has a native alternative', () => {
    const capabilities = getDatabaseDesignerCapabilities('vertica');
    expect(() => buildRelationalIndexSql('"public"."orders"', 'vertica', {
      name: 'orders_idx',
      columns: 'status',
      unique: false,
    }, capabilities.constructs.indexes)).toThrow(UnsupportedDesignerOperationError);
  });

  it('builds the Netezza distribution and zone-map statements together', () => {
    const capabilities = getDatabaseDesignerCapabilities('netezza');
    const sql = buildNetezzaPhysicalDesignSql('"SYSTEM"."ADMIN"."orders"', {
      distributionMethod: 'HASH',
      distributionColumns: 'customer_id',
      organizationColumns: 'created_at',
      organizationNone: false,
      organizationMaxRowsPerZone: '500000',
    }, capabilities.constructs.partitions);
    expect(sql).toContain('DISTRIBUTE ON ("customer_id")');
    expect(sql).toContain('ORGANIZE ON ("created_at")');
    expect(sql).toContain('MAX_ROWS_PER_ZONE=500000');
  });

  it('builds native ClickHouse, Vertica, and Snowflake physical-design statements', () => {
    const clickhouse = getDatabaseDesignerCapabilities('clickhouse');
    expect(buildClickHouseSkippingIndexSql('`analytics`.`events`', {
      name: 'idx_user',
      expression: 'user_id',
      indexType: 'bloom_filter',
      granularity: '4',
    }, clickhouse.constructs.indexes)).toContain('TYPE bloom_filter GRANULARITY 4');
    expect(buildClickHouseSkippingIndexDropSql('`analytics`.`events`', 'idx_user', clickhouse.constructs.indexes)).toBe('ALTER TABLE `analytics`.`events` DROP INDEX `idx_user`;');

    const vertica = getDatabaseDesignerCapabilities('vertica');
    expect(buildVerticaProjectionSql('"public"."events"', {
      name: 'events_super',
      columns: 'user_id, created_at',
      orderBy: 'created_at',
      segmentation: 'HASH(user_id)',
      kSafety: '1',
    }, vertica.constructs.indexes)).toContain('CREATE PROJECTION "events_super"');
    expect(buildVerticaProjectionDropSql('events_super', vertica.constructs.indexes)).toBe('DROP PROJECTION "events_super";');

    const snowflake = getDatabaseDesignerCapabilities('snowflake');
    expect(buildSnowflakeClusteringSql('"ANALYTICS"."PUBLIC"."events"', {
      expressions: 'LINEAR(TO_DATE(created_at), user_id)',
    }, snowflake.constructs.indexes)).toContain('CLUSTER BY (LINEAR(TO_DATE(created_at), user_id))');
    expect(buildSnowflakeClusteringDropSql('"ANALYTICS"."PUBLIC"."events"', snowflake.constructs.indexes)).toBe('ALTER TABLE "ANALYTICS"."PUBLIC"."events" DROP CLUSTERING KEY;');

    expect(buildClickHousePartitionOperationSql('`analytics`.`events`', {
      action: 'OPTIMIZE',
      partition: '202401',
    }, clickhouse.constructs.partitions)).toBe('OPTIMIZE TABLE `analytics`.`events` PARTITION 202401 FINAL;');
  });

  it('allows a Netezza distribution-only physical-design change', () => {
    const netezza = getDatabaseDesignerCapabilities('netezza');
    expect(buildNetezzaPhysicalDesignSql('"SYSTEM"."ADMIN"."orders"', {
      distributionMethod: 'RANDOM',
      distributionColumns: '',
      organizationColumns: '',
      organizationNone: false,
      organizationMaxRowsPerZone: '',
    }, netezza.constructs.partitions)).toBe(
      'ALTER TABLE "SYSTEM"."ADMIN"."orders" DISTRIBUTE ON RANDOM;',
    );
  });

  it('does not emit mutation SQL for a read-only capability state', () => {
    const readOnly = resolveDatabaseDesignerCapabilities(getDatabaseDesignerCapabilities('postgresql'), {
      databaseKind: 'postgresql',
      readOnly: true,
    });
    expect(() => buildAddColumnSql('"public"."orders"', 'postgresql', {
      name: 'blocked',
      dataType: 'INTEGER',
      notNull: false,
      defaultExpression: '',
    }, readOnly.constructs.alterTable)).toThrow(UnsupportedDesignerOperationError);
  });

  it('builds MySQL and PostgreSQL constraint DDL with guarded options', () => {
    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(buildForeignKeySql('"public"."orders"', 'postgresql', {
      name: 'orders_customer_fk',
      columns: 'customer_id',
      referencedSchema: 'public',
      referencedTable: 'customers',
      referencedColumns: 'id',
      match: 'SIMPLE',
      onDelete: 'CASCADE',
      onUpdate: '',
      deferrable: true,
      initiallyDeferred: true,
      notValid: true,
    }, postgresql.constructs.foreignKeys)).toBe(
      'ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") MATCH SIMPLE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;',
    );
    expect(buildCheckConstraintSql('"public"."orders"', 'postgresql', {
      name: 'orders_amount_ck',
      expression: 'amount >= 0',
      notValid: true,
    }, postgresql.constructs.checks)).toContain('CHECK (amount >= 0) NOT VALID');

    const mysql = getDatabaseDesignerCapabilities('mysql');
    expect(buildForeignKeySql('`sales`.`orders`', 'mysql', {
      name: 'orders_customer_fk',
      columns: 'customer_id',
      referencedSchema: 'sales',
      referencedTable: 'customers',
      referencedColumns: 'id',
      match: '',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
      deferrable: false,
      initiallyDeferred: false,
      notValid: false,
    }, mysql.constructs.foreignKeys)).toContain('ON UPDATE CASCADE');
    expect(buildDropConstraintSql('`sales`.`orders`', 'mysql', 'orders_customer_fk', 'foreignKey', mysql.constructs.foreignKeys)).toBe(
      'ALTER TABLE `sales`.`orders` DROP FOREIGN KEY `orders_customer_fk`;',
    );
  });

  it('rejects unsafe or dialect-incompatible constraint options', () => {
    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(() => buildCheckConstraintSql('"public"."orders"', 'postgresql', {
      name: 'bad',
      expression: 'amount >= 0; DROP TABLE users',
      notValid: false,
    }, postgresql.constructs.checks)).toThrow('statement separators');
    const mysql = getDatabaseDesignerCapabilities('mysql');
    expect(() => buildForeignKeySql('`sales`.`orders`', 'mysql', {
      name: 'fk',
      columns: 'customer_id',
      referencedSchema: 'sales',
      referencedTable: 'customers',
      referencedColumns: 'id',
      match: '',
      onDelete: '',
      onUpdate: '',
      deferrable: true,
      initiallyDeferred: false,
      notValid: false,
    }, mysql.constructs.foreignKeys)).toThrow('Deferrable');
  });

  it('allows separators and comment markers inside quoted SQL literals', () => {
    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(buildAddColumnSql('"public"."orders"', 'postgresql', {
      name: 'note',
      dataType: 'TEXT',
      notNull: false,
      defaultExpression: "'a--b;/*still a literal*/'",
    }, postgresql.constructs.alterTable)).toContain("DEFAULT 'a--b;/*still a literal*/'");
    expect(buildCheckConstraintSql('"public"."orders"', 'postgresql', {
      name: 'valid_note',
      expression: "note <> '--'",
      notValid: false,
    }, postgresql.constructs.checks)).toContain("CHECK (note <> '--')");
    expect(buildViewSql('"public"."notes_view"', {
      definition: "SELECT ';' AS separator, '--' AS marker FROM notes",
      replace: false,
    }, postgresql.constructs.views)).toContain("SELECT ';' AS separator, '--' AS marker");
  });

  it('quotes plain string defaults while preserving SQL default expressions', () => {
    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(buildAddColumnSql('"public"."orders"', 'postgresql', {
      name: 'status',
      dataType: 'VARCHAR(32)',
      notNull: false,
      defaultExpression: 'pending',
    }, postgresql.constructs.alterTable)).toContain("DEFAULT 'pending'");
    expect(buildAddColumnSql('"public"."orders"', 'postgresql', {
      name: 'created_at',
      dataType: 'TIMESTAMP',
      notNull: false,
      defaultExpression: 'CURRENT_TIMESTAMP',
    }, postgresql.constructs.alterTable)).toContain('DEFAULT CURRENT_TIMESTAMP');
  });

  it('splits and normalizes dialect-quoted identifiers containing commas', () => {
    const mysql = getDatabaseDesignerCapabilities('mysql');
    expect(buildRelationalIndexSql('`sales`.`orders`', 'mysql', {
      name: 'orders_idx',
      columns: '`a,b`, c',
      unique: false,
    }, mysql.constructs.indexes)).toContain('(`a,b`, `c`)');

    const mssql = getDatabaseDesignerCapabilities('mssql');
    expect(buildRelationalIndexSql('[dbo].[orders]', 'mssql', {
      name: 'orders_idx',
      columns: '[a,b], [c]]d]',
      unique: false,
    }, mssql.constructs.indexes)).toContain('([a,b], [c]]d])');
  });

  it('builds a SQLite row trigger with UPDATE OF and WHEN', () => {
    const sqlite = getDatabaseDesignerCapabilities('sqlite');
    expect(buildTriggerSql('"main"."orders"', 'sqlite', {
      name: 'orders_audit',
      timing: 'AFTER',
      event: 'UPDATE',
      updateColumns: 'status, updated_at',
      level: 'ROW',
      whenExpression: 'NEW.status <> OLD.status',
      body: 'INSERT INTO audit_log(order_id) VALUES (NEW.id);',
      objectType: 'TABLE',
    }, sqlite.constructs.triggers)).toBe(
      'CREATE TRIGGER "orders_audit" AFTER UPDATE OF "status", "updated_at" ON "main"."orders" FOR EACH ROW WHEN (NEW.status <> OLD.status)\nBEGIN\nINSERT INTO audit_log(order_id) VALUES (NEW.id);\nEND;',
    );
  });

  it('uses the dialect trigger body contract for PostgreSQL, Oracle, MSSQL, and Db2', () => {
    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(buildTriggerSql('"public"."orders"', 'postgresql', {
      name: 'orders_audit',
      timing: 'AFTER',
      event: 'UPDATE',
      updateColumns: 'status',
      level: 'ROW',
      whenExpression: 'NEW.status IS DISTINCT FROM OLD.status',
      body: 'audit_orders()',
      objectType: 'TABLE',
    }, postgresql.constructs.triggers)).toBe(
      'CREATE TRIGGER "orders_audit" AFTER UPDATE OF "status" ON "public"."orders" FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION audit_orders();',
    );

    const oracle = getDatabaseDesignerCapabilities('oracle');
    expect(buildTriggerSql('"APP"."ORDERS"', 'oracle', {
      name: 'orders_audit',
      timing: 'BEFORE',
      event: 'INSERT',
      updateColumns: '',
      level: 'ROW',
      whenExpression: '',
      body: 'audit_orders(:NEW.ID);',
      objectType: 'TABLE',
    }, oracle.constructs.triggers)).toContain('CREATE OR REPLACE TRIGGER "orders_audit" BEFORE INSERT ON "APP"."ORDERS" FOR EACH ROW');

    const mssql = getDatabaseDesignerCapabilities('mssql');
    expect(buildTriggerSql('[dbo].[orders]', 'mssql', {
      name: 'orders_audit',
      timing: 'AFTER',
      event: 'INSERT',
      updateColumns: '',
      level: 'STATEMENT',
      whenExpression: '',
      body: 'INSERT INTO audit_log(order_id) SELECT order_id FROM inserted;',
      objectType: 'TABLE',
    }, mssql.constructs.triggers)).toContain('CREATE TRIGGER [orders_audit] ON [dbo].[orders] AFTER INSERT AS');

    const db2 = getDatabaseDesignerCapabilities('db2');
    expect(buildTriggerSql('"APP"."ORDERS"', 'db2', {
      name: 'orders_audit',
      timing: 'AFTER',
      event: 'INSERT',
      updateColumns: '',
      level: 'ROW',
      whenExpression: '',
      body: 'INSERT INTO audit_log VALUES (1);',
      objectType: 'TABLE',
    }, db2.constructs.triggers)).toContain('BEGIN ATOMIC');
  });

  it('rejects SQLite INSTEAD OF triggers on tables and unsupported dialect triggers', () => {
    const sqlite = getDatabaseDesignerCapabilities('sqlite');
    expect(() => buildTriggerSql('"main"."orders"', 'sqlite', {
      name: 'orders_view_trigger',
      timing: 'INSTEAD OF',
      event: 'INSERT',
      updateColumns: '',
      level: 'ROW',
      whenExpression: '',
      body: 'SELECT 1;',
      objectType: 'TABLE',
    }, sqlite.constructs.triggers)).toThrow('VIEW only');

    expect(buildTriggerSql('"main"."orders_view"', 'sqlite', {
      name: 'orders_view_trigger',
      timing: 'INSTEAD OF',
      event: 'INSERT',
      updateColumns: '',
      level: 'ROW',
      whenExpression: '',
      body: 'INSERT INTO orders VALUES (NEW.id);',
      objectType: 'VIEW',
    }, sqlite.constructs.triggers)).toContain('INSTEAD OF INSERT ON "main"."orders_view"');

    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(() => buildTriggerSql('"public"."orders_view"', 'postgresql', {
      name: 'orders_view_trigger',
      timing: 'INSTEAD OF',
      event: 'INSERT',
      updateColumns: '',
      level: 'STATEMENT',
      whenExpression: '',
      body: 'route_order()',
      objectType: 'VIEW',
    }, postgresql.constructs.triggers)).toThrow('Trigger level STATEMENT');

    const clickhouse = getDatabaseDesignerCapabilities('clickhouse');
    expect(() => buildTriggerSql('`analytics`.`events`', 'clickhouse', {
      name: 'events_trigger',
      timing: 'AFTER',
      event: 'INSERT',
      updateColumns: '',
      level: 'ROW',
      whenExpression: '',
      body: 'SELECT 1;',
    }, clickhouse.constructs.triggers)).toThrow(UnsupportedDesignerOperationError);
  });

  it('uses the manifest replacement strategy for view definitions', () => {
    const sqlite = getDatabaseDesignerCapabilities('sqlite');
    expect(buildViewSql('"main"."customer_totals"', {
      definition: 'SELECT customer_id, count(*) AS order_count FROM orders;',
      replace: true,
    }, sqlite.constructs.views)).toBe(
      'DROP VIEW IF EXISTS "main"."customer_totals";\nCREATE VIEW "main"."customer_totals" AS\nSELECT customer_id, count(*) AS order_count FROM orders;',
    );

    const postgresql = getDatabaseDesignerCapabilities('postgresql');
    expect(buildViewSql('"public"."customer_totals"', {
      definition: 'SELECT customer_id FROM orders',
      replace: true,
    }, postgresql.constructs.views)).toBe(
      'CREATE OR REPLACE VIEW "public"."customer_totals" AS\nSELECT customer_id FROM orders;',
    );

    const db2 = getDatabaseDesignerCapabilities('db2');
    expect(() => buildViewSql('"APP"."CUSTOMER_TOTALS"', {
      definition: 'SELECT customer_id FROM orders',
      replace: true,
    }, db2.constructs.views)).toThrow('Replacing an existing view');
  });

  it('builds a guarded Netezza NZPLSQL routine template', () => {
    const netezza = getDatabaseDesignerCapabilities('netezza');
    expect(buildNetezzaRoutineSql('"SYSTEM"."ADMIN"."GET_ORDER"', {
      parameters: 'INTEGER, VARCHAR(100)',
      returnType: 'INTEGER',
      executeAs: 'OWNER',
      body: 'RETURN 1;',
    }, netezza.constructs.procedures)).toContain(
      'CREATE OR REPLACE PROCEDURE "SYSTEM"."ADMIN"."GET_ORDER"(INTEGER, VARCHAR(100))',
    );
    expect(() => buildNetezzaRoutineSql('"SYSTEM"."ADMIN"."GET_ORDER"', {
      parameters: '',
      returnType: 'INTEGER',
      executeAs: 'OWNER',
      body: 'END_PROC;',
    }, netezza.constructs.procedures)).toThrow('END_PROC');

    const sqlite = getDatabaseDesignerCapabilities('sqlite');
    expect(() => buildNetezzaRoutineSql('"main"."routine"', {
      parameters: '',
      returnType: 'INTEGER',
      executeAs: 'OWNER',
      body: 'RETURN 1;',
    }, sqlite.constructs.procedures)).toThrow(UnsupportedDesignerOperationError);
  });
});
