import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect
} from '@justybase/contracts';
import { createDatabaseCapabilities } from '@justybase/contracts';
import { duckdbDialectTraits } from '../../../src/dialects/duckdb/traits';
import { DuckDbConnection } from './duckdbConnection';
import { duckdbMetadataProvider } from './duckdbSchemaProvider';
import { duckdbSqlAuthoring } from './duckdbSqlAuthoring';
import { duckdbDdlProvider } from './duckdbDdlProvider';
import { duckdbImportTypeMapper } from './duckdbImportTypeMapper';
import { duckdbMaintenanceProvider } from './duckdbMaintenanceProvider';
import { duckdbCopilotReferenceProvider } from './duckdbReferenceProvider';
import { duckdbSessionMonitorProvider } from './duckdbSessionMonitorProvider';
import { duckdbTuningAdvisor } from './duckdbTuningAdvisor';

const duckdbConnectionConstructor = DuckDbConnection as unknown as DatabaseConnectionStaticConstructor;

export const duckdbDialect: DatabaseDialect = {
    kind: 'duckdb',
    displayName: 'DuckDB',
    capabilities: createDatabaseCapabilities({
        supportsExplainPlan: true,
        supportsExplainGraph: true,
        supportsTuningAdvisor: true,
        supportsTableMaintenance: true,
        supportsSessionMonitor: true
    }),
    connectionForm: {
        fields: [
            {
                key: 'mode',
                label: 'Mode',
                type: 'select',
                storage: 'options',
                defaultValue: 'file',
                options: [
                    {
                        value: 'file',
                        label: 'File path'
                    },
                    {
                        value: 'memory',
                        label: 'In-memory (:memory:)'
                    }
                ],
                description: 'Choose whether to connect to a DuckDB file or use an in-memory database.',
                layout: 'full'
            },
            {
                key: 'database',
                label: 'Database Path',
                type: 'text',
                storage: 'topLevel',
                required: true,
                placeholder: 'Existing or new DuckDB file (for example C:\\data\\analytics.duckdb)',
                description:
                    'Existing or new DuckDB database file path. When Mode is set to In-memory, this field is auto-filled with :memory:.',
                layout: 'full'
            },
            {
                key: 'schema',
                label: 'Schema',
                type: 'text',
                storage: 'options',
                placeholder: 'Optional default schema (for example main)',
                description: 'Optional schema selected after connecting. Defaults to DuckDB\'s main schema.',
                layout: 'half'
            }
        ]
    },
    traits: duckdbDialectTraits,
    metadataProvider: duckdbMetadataProvider,
    sqlAuthoring: duckdbSqlAuthoring,
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        return duckdbConnectionConstructor;
    },
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
        return new DuckDbConnection(config);
    },
    advancedFeatures: {
        ddl: duckdbDdlProvider,
        importTypeMapper: duckdbImportTypeMapper,
        tuningAdvisor: duckdbTuningAdvisor,
        maintenance: duckdbMaintenanceProvider,
        copilotReferenceProvider: duckdbCopilotReferenceProvider,
        sessionMonitor: duckdbSessionMonitorProvider
    }
};
