import {
    createDatabaseCapabilities,
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect
} from '../../contracts/database';
import { sqliteConnectionForm } from './connectionForm';
import { sqliteMetadataProvider } from './metadata/provider';
import { sqliteSqlAuthoring } from './sql/authoring';
import { SqliteConnection } from './runtime';
import { sqliteAdvancedFeatures } from './advancedFeatures';
import { sqliteDialectTraits } from './traits';

export { SqliteConnection } from './runtime';

const sqliteConnectionConstructor = SqliteConnection as unknown as DatabaseConnectionStaticConstructor;

export const sqliteDialect: DatabaseDialect = {
    kind: 'sqlite',
    displayName: 'SQLite',
    capabilities: createDatabaseCapabilities(),
    connectionForm: sqliteConnectionForm,
    traits: sqliteDialectTraits,
    metadataProvider: sqliteMetadataProvider,
    sqlAuthoring: sqliteSqlAuthoring,
    advancedFeatures: sqliteAdvancedFeatures,
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        return sqliteConnectionConstructor;
    },
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
        return new SqliteConnection(config);
    }
};
