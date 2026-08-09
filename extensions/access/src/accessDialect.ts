/**
 * 'access' dialect: query Microsoft Access (.mdb/.accdb) files with SQL
 * through a Java sidecar running the UCanAccess JDBC driver. The traits and
 * SQL authoring live in the core extension; this package contributes the
 * connection class and the Java bridge process.
 */

import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect,
} from '@justybase/contracts';
import { createDatabaseCapabilities } from '@justybase/contracts';
import { accessDialectTraits } from '../../../src/dialects/access/traits';
import { AccessConnection } from './accessConnection';
import { accessMetadataProvider } from './accessSchemaProvider';
import { accessSqlAuthoring } from './accessSqlAuthoring';

const accessConnectionConstructor = AccessConnection as unknown as DatabaseConnectionStaticConstructor;

export const accessDialect: DatabaseDialect = {
    kind: 'access',
    displayName: 'Microsoft Access',
    capabilities: createDatabaseCapabilities({}),
    connectionForm: {
        fields: [
            {
                key: 'filePath',
                label: 'Access Database File',
                type: 'file',
                storage: 'topLevel',
                required: true,
                placeholder: 'Select a .mdb or .accdb file',
                description: 'Microsoft Access database queried and edited with SQL. Requires a Java 11+ runtime (JRE) on the system.',
                layout: 'full'
            },
            {
                key: 'password',
                label: 'Database Password',
                type: 'password',
                placeholder: 'Optional Access database password',
                description: 'Password for the Access database file, if it is protected. This value is stored securely.',
                layout: 'full'
            },
            {
                key: 'readOnly',
                label: 'Open database as read-only',
                type: 'checkbox',
                storage: 'options',
                defaultValue: true,
                description: 'Protect the Access file from INSERT, UPDATE, DELETE, and DDL. Disable only when writing is required. Reconnect open SQL tabs after changing this option.',
                layout: 'full'
            }
        ]
    },
    traits: accessDialectTraits,
    metadataProvider: accessMetadataProvider,
    sqlAuthoring: accessSqlAuthoring,
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        return accessConnectionConstructor;
    },
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
        return new AccessConnection(config);
    }
};
