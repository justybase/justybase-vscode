import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect,
} from '@justybase/contracts';
import { createDatabaseCapabilities } from '@justybase/contracts';
import { createStandardConnectionFields } from '../../../src/core/connectionFormBuilder';
import { clickhouseDialectTraits } from '../../../src/shared/dialect-traits/clickhouse';
import { ClickHouseConnection } from './clickhouseConnection';
import { clickhouseAdvancedFeatures } from './clickhouseDdlGenerator';
import { clickhouseMetadataProvider } from './clickhouseSchemaProvider';
import { clickhouseSqlAuthoring } from './clickhouseSqlAuthoring';

const clickhouseConnectionConstructor = ClickHouseConnection as unknown as DatabaseConnectionStaticConstructor;

export const clickhouseDialect: DatabaseDialect = {
    kind: 'clickhouse',
    displayName: 'ClickHouse',
    defaultPort: 8123,
    capabilities: createDatabaseCapabilities({
        supportsExplainPlan: true,
        supportsExplainGraph: false,
        supportsTableMaintenance: true,
        supportsSessionMonitor: true,
    }),
    connectionForm: {
        fields: [
            ...createStandardConnectionFields({
                defaultPort: 8123,
                hostPlaceholder: 'ClickHouse host or URL',
                databasePlaceholder: 'Database name (default: default)',
                userPlaceholder: 'ClickHouse user',
            }),
            {
                key: 'protocol',
                label: 'Protocol',
                type: 'select',
                storage: 'options',
                defaultValue: 'http',
                options: [
                    { value: 'http', label: 'HTTP' },
                    { value: 'https', label: 'HTTPS / TLS' },
                ],
                description: 'ClickHouse HTTP interface protocol.',
                layout: 'half',
            },
            {
                key: 'tlsMode',
                label: 'TLS certificate',
                type: 'select',
                storage: 'options',
                defaultValue: 'verify-full',
                options: [
                    { value: 'verify-full', label: 'Verify certificate' },
                    { value: 'require', label: 'Encrypt, skip validation' },
                ],
                description: 'Used for HTTPS connections. Custom CA files are not required in v1.',
                layout: 'half',
            },
            {
                key: 'requestTimeout',
                label: 'Request timeout (ms)',
                type: 'number',
                storage: 'options',
                defaultValue: 30000,
                min: 1000,
                max: 3600000,
                description: 'HTTP request timeout passed to the ClickHouse client.',
                layout: 'half',
            },
        ],
    },
    traits: clickhouseDialectTraits,
    metadataProvider: clickhouseMetadataProvider,
    sqlAuthoring: clickhouseSqlAuthoring,
    advancedFeatures: clickhouseAdvancedFeatures,
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        return clickhouseConnectionConstructor;
    },
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
        return new ClickHouseConnection(config);
    },
};
