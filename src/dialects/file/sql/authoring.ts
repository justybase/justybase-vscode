import type { DatabaseSqlAuthoring } from '../../../sql/authoring/types';
import { duckdbSqlAuthoring } from '../../duckdb/sql/authoring';
import { fileSqlQualityRules } from '../../../../extensions/duckdb/src/sql/qualityRules';

export const fileSqlAuthoring: DatabaseSqlAuthoring = {
  ...duckdbSqlAuthoring,
  validation: {
    ...duckdbSqlAuthoring.validation,
    databaseKind: 'file',
  },
  qualityRules: fileSqlQualityRules,
};
