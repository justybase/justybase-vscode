import {
    createDatabaseCapabilities,
    DatabaseAdvancedFeatures,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect
} from '../../contracts/database';
import { sqliteConnectionForm } from './connectionForm';
import { sqliteMetadataProvider } from './metadata/provider';
import { sqliteSqlAuthoring } from './sql/authoring';
import { SqliteConnection } from './runtime';
import { sqliteDialectTraits } from './traits';

export { SqliteConnection } from './runtime';

const sqliteConnectionConstructor = SqliteConnection as unknown as DatabaseConnectionStaticConstructor;

let _cachedAdvancedFeatures: DatabaseAdvancedFeatures | undefined;

function getAdvancedFeatures(): DatabaseAdvancedFeatures {
    if (!_cachedAdvancedFeatures) {
        const { sqliteAdvancedFeatures } = require('./advancedFeatures');
        _cachedAdvancedFeatures = sqliteAdvancedFeatures;
    }
    return _cachedAdvancedFeatures!;
}

export const sqliteDialect: DatabaseDialect = {
    kind: 'sqlite',
    displayName: 'SQLite',
    capabilities: createDatabaseCapabilities({
        supportsExplainPlan: true,
        supportsExplainGraph: true,
        supportsTuningAdvisor: true,
        supportsTableMaintenance: true,
    }),
    connectionForm: sqliteConnectionForm,
    traits: sqliteDialectTraits,
    metadataProvider: sqliteMetadataProvider,
    sqlAuthoring: sqliteSqlAuthoring,
    get advancedFeatures(): DatabaseAdvancedFeatures {
        return getAdvancedFeatures();
    },
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        return sqliteConnectionConstructor;
    },
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
        return new SqliteConnection(config);
    }
};
