import type { LintRule } from '../../providers/linterRules';
import type {
    DatabaseSqlAuthoring as SharedDatabaseSqlAuthoring,
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlParsingProfile,
    DatabaseSqlStaticAssetProfile,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile,
} from '@justybase/contracts';

export type {
    DatabaseSqlFormatterProfile,
    DatabaseSqlFunctionSignature,
    DatabaseSqlParsingProfile,
    DatabaseSqlStaticAssetProfile,
    DatabaseSqlTypeSpec,
    DatabaseSqlValidationProfile,
};

export type DatabaseSqlAuthoring = Omit<SharedDatabaseSqlAuthoring, 'qualityRules'> & {
    qualityRules: readonly LintRule[];
};
