import { describe, expect, it } from '@jest/globals';
import { getDatabaseDesignerCapabilities, resolveDatabaseDesignerCapabilities } from '@justybase/contracts';
import {
  buildObjectDesignerSql,
  type ObjectDesignerDraft,
} from '../src';

function draft(overrides: Partial<ObjectDesignerDraft> = {}): ObjectDesignerDraft {
  return {
    activeTab: 'columns',
    columnName: 'status',
    columnType: 'VARCHAR(32)',
    columnNotNull: true,
    columnDefault: "'new'",
    indexName: '',
    indexColumns: '',
    indexUnique: false,
    indexOperation: 'create',
    distributionChanged: false,
    distributionMethod: 'RANDOM',
    distributionColumns: '',
    organizationColumns: '',
    organizationNone: false,
    organizationMaxRowsPerZone: '',
    clickHouseIndex: { name: '', expression: '', indexType: 'minmax', granularity: '1' },
    clickHousePartition: { action: 'DROP', partition: '' },
    verticaProjection: { name: '', columns: '', orderBy: '', segmentation: '', kSafety: '1' },
    snowflakeClustering: { expressions: '' },
    constraintType: 'foreignKey',
    constraintOperation: 'create',
    constraintName: '',
    foreignKeyColumns: '',
    referencedSchema: 'public',
    referencedTable: '',
    referencedColumns: '',
    foreignKeyMatch: '',
    foreignKeyOnDelete: '',
    foreignKeyOnUpdate: '',
    foreignKeyDeferrable: false,
    foreignKeyInitiallyDeferred: false,
    foreignKeyNotValid: false,
    checkExpression: '',
    checkNotValid: false,
    triggerName: '',
    triggerOperation: 'create',
    triggerTiming: 'BEFORE',
    triggerEvent: 'INSERT',
    triggerUpdateColumns: '',
    triggerLevel: 'ROW',
    triggerWhen: '',
    triggerBody: '',
    viewDefinition: '',
    viewReplace: false,
    routineParameters: '',
    routineReturnType: 'INTEGER',
    routineExecuteAs: 'OWNER',
    routineBody: 'RETURN 1;',
    ...overrides,
  };
}

describe('object designer SQL model', () => {
  it('delegates column SQL generation through the shared capability context', () => {
    const capabilities = getDatabaseDesignerCapabilities('postgresql');

    expect(buildObjectDesignerSql({
      targetSql: '"public"."orders"',
      databaseKind: 'postgresql',
      targetObjectType: 'TABLE',
      capabilities,
      draft: draft(),
    })).toBe('ALTER TABLE "public"."orders" ADD COLUMN "status" VARCHAR(32) DEFAULT \'new\' NOT NULL;');
  });

  it('selects the view builder for view targets', () => {
    const capabilities = getDatabaseDesignerCapabilities('postgresql');

    expect(buildObjectDesignerSql({
      targetSql: '"public"."orders_view"',
      databaseKind: 'postgresql',
      targetObjectType: 'VIEW',
      capabilities,
      draft: draft({
        activeTab: 'definition',
        viewDefinition: 'SELECT * FROM "public"."orders"',
        viewReplace: true,
      }),
    })).toBe('CREATE OR REPLACE VIEW "public"."orders_view" AS\nSELECT * FROM "public"."orders";');
  });

  it('preserves native index routing and read-only guards', () => {
    const clickhouse = getDatabaseDesignerCapabilities('clickhouse');
    expect(buildObjectDesignerSql({
      targetSql: '`analytics`.`events`',
      databaseKind: 'clickhouse',
      targetObjectType: 'TABLE',
      capabilities: clickhouse,
      draft: draft({
        activeTab: 'indexes',
        clickHouseIndex: { name: 'idx_user', expression: 'user_id', indexType: 'bloom_filter', granularity: '4' },
      }),
    })).toBe('ALTER TABLE `analytics`.`events` ADD INDEX `idx_user` user_id TYPE bloom_filter GRANULARITY 4;');

    const readOnly = resolveDatabaseDesignerCapabilities(getDatabaseDesignerCapabilities('postgresql'), {
      databaseKind: 'postgresql',
      readOnly: true,
    });
    expect(() => buildObjectDesignerSql({
      targetSql: '"public"."orders"',
      databaseKind: 'postgresql',
      targetObjectType: 'TABLE',
      capabilities: readOnly,
      draft: draft(),
    })).toThrow('read-only');
  });
});
