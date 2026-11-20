jest.unmock('chevrotain');

import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { grantSql, refreshMaterializedViewSql } from '../../commands/schema/menuSql';
import type { MenuObjectRef } from '../../commands/schema/menuSql';
import {
  buildPostgresqlAnalyzeSql,
  buildPostgresqlAttachPartitionSql,
  buildPostgresqlCreatePartitionSql,
  buildPostgresqlReindexTableSql,
  buildPostgresqlVacuumSql,
  postgresqlMaintenanceProvider,
} from '../../../extensions/postgresql/src/postgresqlMaintenanceProvider';

const postgres: MenuObjectRef = { database: 'shop', schema: 'public', name: 'items' };

function expectParses(sql: string): void {
  const result = parseSqlStatements({ sql, databaseKind: 'postgresql' });
  expect(result.lexResult.errors).toEqual([]);
  expect(
    result.actionableParserErrors.map(error => ({
      message: error.message,
      token: error.token?.image,
      offset: error.token?.startOffset,
      sql,
    })),
  ).toEqual([]);
}

describe('PostgreSQL generated SQL parses cleanly', () => {
  it('keeps the maintenance provider wired to the shared builders', () => {
    expect(postgresqlMaintenanceProvider.vacuumTable).toBeDefined();
    expect(postgresqlMaintenanceProvider.analyzeTable).toBeDefined();
    expect(postgresqlMaintenanceProvider.reindexTable).toBeDefined();
    expect(postgresqlMaintenanceProvider.createPartition).toBeDefined();
    expect(postgresqlMaintenanceProvider.attachPartition).toBeDefined();
  });

  it.each([
    buildPostgresqlVacuumSql('VACUUM', '"public"."items"'),
    buildPostgresqlVacuumSql('VACUUM (FULL)', '"public"."items"'),
    buildPostgresqlVacuumSql('VACUUM (ANALYZE)', '"public"."items"'),
    buildPostgresqlAnalyzeSql('ANALYZE', '"public"."items"'),
    buildPostgresqlAnalyzeSql('ANALYZE VERBOSE', '"public"."items"'),
    buildPostgresqlReindexTableSql('"public"."items"'),
    buildPostgresqlCreatePartitionSql('"public"."p2026"', '"public"."p"', {
      partitionBound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
    }),
    buildPostgresqlCreatePartitionSql('"public"."p_default"', '"public"."p"', {
      partitionBound: '',
      isDefault: true,
    }),
    buildPostgresqlCreatePartitionSql('"public"."p2026"', '"public"."p"', {
      partitionBound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
      tablespace: 'fast',
    }),
    buildPostgresqlAttachPartitionSql('"public"."p"', '"public"."p2026"', "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')"),
  ])('parses provider SQL: %s', sql => {
    expectParses(sql);
  });

  it.each([
    grantSql('postgresql', postgres, 'TABLE', 'SELECT', 'app_user'),
    grantSql('postgresql', postgres, 'TABLE', 'ALL', 'app_user'),
    refreshMaterializedViewSql('postgresql', 'MATERIALIZED VIEW', postgres),
    refreshMaterializedViewSql('postgresql', 'MATERIALIZED VIEW', postgres, { concurrently: true }),
  ])('parses shared menu SQL: %s', sql => {
    expectParses(sql);
  });
});
