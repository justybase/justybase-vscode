import type { DatabaseSqlAuthoring } from '@justybase/sql-core/authoring/types';
import { duckdbSqlAuthoring } from './duckdb/authoring';
import { fileSqlQualityRules } from './duckdb/qualityRules';

export const fileSqlAuthoring: DatabaseSqlAuthoring = {
  ...duckdbSqlAuthoring,
  validation: {
    ...duckdbSqlAuthoring.validation,
    databaseKind: 'file',
  },
  qualityRules: fileSqlQualityRules,
};
